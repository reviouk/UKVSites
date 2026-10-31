/**
 * Public routes embedded in every email:
 *   GET  /o/:token.gif      open pixel
 *   GET  /c/:token?u=URL    click redirect
 *   GET  /u/:token          unsubscribe (confirmation page)
 *   POST /u/:token          one-click unsubscribe (RFC 8058 List-Unsubscribe-Post)
 */
import { Router } from "express";
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

tracking.get("/c/:token", async (req, res) => {
  const url = String(req.query.u || "");
  const safe = /^https?:\/\//i.test(url) ? url : (SITES.marketwatcher.url);
  res.redirect(302, safe);
  try {
    const s = await lookup(req.params.token);
    if (!s) return;
    const ua = req.get("user-agent") || "";
    await q("INSERT INTO events(send_id,contact_id,type,detail,ip,user_agent) VALUES($1,$2,'click',$3,$4,$5)", [s.id, s.contact_id, safe, req.ip, ua]);
    // Security scanners click every link within seconds of delivery; ignore clicks < 20s after send.
    const ageMs = Date.now() - new Date(s.sent_at).getTime();
    if (ageMs < 20_000 || isBot(ua)) return;
    if (!s.clicked_at) {
      await q("UPDATE sends SET clicked_at=now(), opened_at=COALESCE(opened_at, now()) WHERE id=$1", [s.id]);
      syncEngagement({ contact: s, campaign: { name: s.campaign_name }, engagement: "clicked", site: s.site });
    }
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

tracking.post("/u/:token", async (req, res) => {
  try { await unsubscribe(req.params.token, "one-click"); } catch (e) { console.warn("[unsub]", e.message); }
  res.status(200).send("Unsubscribed");
});

tracking.get("/u/:token", async (req, res) => {
  let s = null;
  try { s = await unsubscribe(req.params.token, "link"); } catch (e) { console.warn("[unsub]", e.message); }
  const brand = s ? (SITES[s.site]?.label || "us") : "us";
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Georgia,serif;max-width:560px;margin:60px auto;padding:0 20px;color:#222;line-height:1.6">
<h1 style="font-weight:500">${s ? "You're unsubscribed" : "Link not recognised"}</h1>
<p>${s ? `<strong>${s.email}</strong> has been removed from all ${brand} mailings. You won't hear from us again.` : "That link has already been used or has expired. If you are still receiving emails, reply to one of them and we will remove you by hand."}</p>
</body></html>`);
});
