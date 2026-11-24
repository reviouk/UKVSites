/**
 * Public routes embedded in every email:
 *   GET  /o/:token.gif      open pixel
 *   GET  /c/:token?u=URL    click redirect
 *   GET  /u/:token          unsubscribe (confirmation page)
 *   POST /u/:token          one-click unsubscribe (RFC 8058 List-Unsubscribe-Post)
 */
import express, { Router } from "express";
import { q, one } from "./db.js";
import { syncEngagement } from "./hubspot.js";
import { SITES } from "./config.js";

export const tracking = Router();
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function lookup(token) {
  return one(`
    SELECT s.*, c.name AS campaign_name, c.site, ct.email, ct.first_name, ct.last_name, ct.company, ct.phone, ct.data_source, ct.status AS contact_status
      FROM sends s JOIN campaigns c ON c.id = s.campaign_id JOIN contacts ct ON ct.id = s.contact_id
     WHERE s.token = $1`, [token]);
}

const isBot = (ua = "") => /GoogleImageProxy|bot|crawler|spider|preview|Proofpoint|Barracuda|Mimecast|Symantec|scanner/i.test(ua);

tracking.get("/o/:token.gif", async (req, res) => {
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, private", "Content-Length": PIXEL.length });
  res.end(PIXEL);
  try {
    const s = await lookup(req.params.token);
    if (!s) return;
    // Opens are noisy (Apple MPP, corporate link scanners) but still useful for the HubSpot "opened" list.
    await q("INSERT INTO events(send_id,contact_id,type,ip,user_agent) VALUES($1,$2,'open',$3,$4)", [s.id, s.contact_id, req.ip, req.get("user-agent")]);
    if (!s.opened_at) {
      await q("UPDATE sends SET opened_at=now() WHERE id=$1", [s.id]);
      syncEngagement({ contact: s, campaign: { name: s.campaign_name }, engagement: "opened", site: s.site });
    }
  } catch (e) { console.warn("[track] open", e.message); }
});

// Link scanners (e.g. Microsoft Safe Links) open every link in an email within a second or two, including the
// unsubscribe link. A real person clicks one link. So a click only counts once it has stood for 20 s with no other
// link from the same email hit within 10 s of it; otherwise those hits are relabelled 'click_scan'.
const SCAN_WINDOW = "10 seconds";
async function settleClick(s, eventId) {
  const ev = await one("SELECT created_at FROM events WHERE id=$1 AND type='click'", [eventId]);
  if (!ev) return;
  const near = `send_id=$1 AND type IN ('click','click_scan','unsub_view') AND created_at BETWEEN $2::timestamptz - interval '${SCAN_WINDOW}' AND $2::timestamptz + interval '${SCAN_WINDOW}'`;
  const { n } = await one(`SELECT count(DISTINCT CASE WHEN type='unsub_view' THEN 'unsub' ELSE detail END)::int n FROM events WHERE ${near}`, [s.id, ev.created_at]);
  if (n >= 2) { await q(`UPDATE events SET type='click_scan' WHERE type='click' AND ${near}`, [s.id, ev.created_at]); return; }
  const cur = await one("SELECT clicked_at FROM sends WHERE id=$1", [s.id]);
  if (!cur?.clicked_at) {
    await q("UPDATE sends SET clicked_at=now(), opened_at=COALESCE(opened_at, now()) WHERE id=$1", [s.id]);
    syncEngagement({ contact: s, campaign: { name: s.campaign_name }, engagement: "clicked", site: s.site });
  }
}

tracking.get("/c/:token", async (req, res) => {
  const url = String(req.query.u || "");
  const safe = /^https?:\/\//i.test(url) ? url : (SITES.marketwatcher.url);
  res.redirect(302, safe);
  try {
    const s = await lookup(req.params.token);
    if (!s) return;
    const ua = req.get("user-agent") || "";
    // Clicks within 20 s of sending, or from a known scanner, are never a person.
    const ageMs = Date.now() - new Date(s.sent_at).getTime();
    const scan = ageMs < 20_000 || isBot(ua);
    const ev = await one("INSERT INTO events(send_id,contact_id,type,detail,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [s.id, s.contact_id, scan ? "click_scan" : "click", safe, req.ip, ua]);
    if (!scan) setTimeout(() => settleClick(s, ev.id).catch(e => console.warn("[track] click settle", e.message)), 20_000);
  } catch (e) { console.warn("[track] click", e.message); }
});

async function unsubscribe(token, how) {
  const s = await lookup(token);
  if (!s) return null;
  await q("INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT DO NOTHING", [s.email, `unsubscribe:${how}`]);
  await q("UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1", [s.contact_id]);
  await q("UPDATE enrolments SET status='stopped', stop_reason='unsubscribed' WHERE contact_id=$1 AND status='active'", [s.contact_id]);
  await q("INSERT INTO events(send_id,contact_id,type,detail) VALUES($1,$2,'unsubscribe',$3)", [s.id, s.contact_id, how]);
  syncEngagement({ contact: s, campaign: { name: s.campaign_name }, engagement: "unsubscribed", site: s.site });
  return s;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"></head>
<body style="font-family:Georgia,serif;max-width:560px;margin:60px auto;padding:0 20px;color:#222;line-height:1.6">${body}</body></html>`;
const esc = (x) => String(x || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// POST: the mail app's one-click unsubscribe (RFC 8058, body "List-Unsubscribe=One-Click") or the button below.
tracking.post("/u/:token", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
  const viaButton = req.body?.confirm === "1";
  let s = null;
  try { s = await unsubscribe(req.params.token, viaButton ? "link" : "one-click"); } catch (e) { console.warn("[unsub]", e.message); }
  if (!viaButton) return res.status(200).send("Unsubscribed");
  const brand = s ? (SITES[s.site]?.label || "us") : "us";
  res.status(200).send(page("Unsubscribed", s
    ? `<h1 style="font-weight:500">You're unsubscribed</h1><p><strong>${esc(s.email)}</strong> has been removed from all ${esc(brand)} mailings. You won't hear from us again.</p>`
    : `<h1 style="font-weight:500">Link not recognised</h1><p>If you are still receiving emails, reply to one of them and we will remove you by hand.</p>`));
});

// GET: a confirmation page only. Link scanners open every link but never press the button, so they can no longer
// unsubscribe people. The view is logged ('unsub_view') so a scanner's other clicks can be recognised.
tracking.get("/u/:token", async (req, res) => {
  let s = null;
  try {
    s = await lookup(req.params.token);
    if (s) await q("INSERT INTO events(send_id,contact_id,type,ip,user_agent) VALUES($1,$2,'unsub_view',$3,$4)", [s.id, s.contact_id, req.ip, req.get("user-agent")]);
  } catch (e) { console.warn("[unsub view]", e.message); }
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  if (!s) return res.status(200).send(page("Unsubscribe", `<h1 style="font-weight:500">Link not recognised</h1><p>If you are still receiving emails, reply to one of them and we will remove you by hand.</p>`));
  const brand = SITES[s.site]?.label || "us";
  if (s.contact_status === "unsubscribed") return res.status(200).send(page("Unsubscribed", `<h1 style="font-weight:500">You're already unsubscribed</h1><p><strong>${esc(s.email)}</strong> won't receive any more ${esc(brand)} emails.</p>`));
  res.status(200).send(page("Unsubscribe", `<h1 style="font-weight:500">Unsubscribe</h1>
<p>Stop all ${esc(brand)} emails to <strong>${esc(s.email)}</strong>?</p>
<form method="post" action="/u/${encodeURIComponent(req.params.token)}"><input type="hidden" name="confirm" value="1">
<button type="submit" style="font:16px Georgia,serif;padding:12px 26px;border:0;border-radius:6px;background:#222;color:#fff;cursor:pointer">Unsubscribe</button></form>`));
});
