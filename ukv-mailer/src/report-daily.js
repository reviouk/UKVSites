/**
 * Daily client email (Mike, from 25 Nov 2026): yesterday's sending per brand with opens, clicks,
 * replies (opt-outs removed automatically), unsubscribes, form fills, and where people are in the
 * HubSpot brochure follow-up. Never names the sending tools; no capacity or bounce notes (Rob).
 *
 * Settings (settings table, editable without a redeploy):
 *   report_email_enabled  "true" to send        report_email_start  first send date (YYYY-MM-DD, local)
 *   report_email_to / _cc  comma lists          report_email_mailbox  mailer mailbox that sends it
 */
import { cfg, SITES } from "./config.js";
import { all, getSetting } from "./db.js";
import { escapeHtml as h } from "./templates.js";
import { isOptOut, replyOnly } from "./optout.js";
import { bounceWatchState } from "./bounce-watch.js";

const BRANDS = ["investchronicles", "marketwatcher"];
const BRAND_LABEL = { investchronicles: "The Invest Chronicle", marketwatcher: "Market Watcher" };
const BROCHURE_LISTS = [1892, 1893, 1900, 1901];          // Opened/Clicked lists that trigger workflow 1840795533
const BACKFILL_ENROLLED_AT = Date.parse("2026-11-17T18:05:00Z"); // existing members enrolled by hand then
const n = (x) => Number(x || 0).toLocaleString("en-GB");
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");

export const dailyEmailSettings = async () => ({
  enabled: (await getSetting("report_email_enabled", "")) === "true",
  start: await getSetting("report_email_start", ""),
  to: (await getSetting("report_email_to", "")).split(",").map(s => s.trim()).filter(Boolean),
  cc: (await getSetting("report_email_cc", "")).split(",").map(s => s.trim()).filter(Boolean),
  mailbox: await getSetting("report_email_mailbox", ""),
  internalTo: (await getSetting("report_internal_to", "")).split(",").map(s => s.trim()).filter(Boolean),
});

async function instantlyDay(day) {
  const key = process.env.INSTANTLY_REPORT_API_KEY;
  const camps = String(process.env.INSTANTLY_REPORT_CAMPAIGNS || "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher")
    .split(",").map(s => s.trim()).filter(Boolean).map(s => { const [id, site] = s.split(":"); return { id, site: site || "marketwatcher" }; });
  const out = Object.fromEntries(BRANDS.map(b => [b, { sent: 0, opened: 0, clicks: 0 }]));
  if (!key) return out;
  for (const { id, site } of camps) {
    try {
      const r = await fetch(`https://api.instantly.ai/api/v2/campaigns/analytics/daily?campaign_id=${encodeURIComponent(id)}&start_date=${day}&end_date=${day}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) continue;
      const body = await r.json();
      for (const d of (Array.isArray(body) ? body : body.items || [])) {
        if (String(d.date || "").slice(0, 10) !== day) continue;
        const b = out[BRANDS.includes(site) ? site : "marketwatcher"];
        b.sent += Number(d.sent || 0); b.opened += Number(d.unique_opened || 0); b.clicks += Number(d.unique_clicks || 0);
      }
    } catch (e) { console.warn("[daily-email] instantly", e.message); }
  }
  return out;
}

// HubSpot list labels for the client email's running totals.
const LIST_LABEL = { 1892: ["Opened", "investchronicles"], 1893: ["Opened", "marketwatcher"], 1900: ["Clicked", "investchronicles"], 1901: ["Clicked", "marketwatcher"] };

async function brochureStages(day) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return null;
  const joined = new Map(), lists = {};
  try {
    for (const id of BROCHURE_LISTS) {
      let after;
      do {
        const r = await fetch(`https://api.hubapi.com/crm/v3/lists/${id}/memberships/join-order?limit=250${after ? "&after=" + after : ""}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return null;
        const j = await r.json();
        lists[id] ??= { total: 0, added: 0 };
        for (const m of j.results || []) {
          lists[id].total++;
          if (day && new Date(m.membershipTimestamp).toLocaleDateString("en-CA", { timeZone: cfg.tz }) === day) lists[id].added++;
          const t = Math.max(Date.parse(m.membershipTimestamp) || 0, BACKFILL_ENROLLED_AT);
          if (!joined.has(m.recordId) || t < joined.get(m.recordId)) joined.set(m.recordId, t);
        }
        after = j.paging?.next?.after;
      } while (after);
    }
  } catch { return null; }
  const now = Date.now(), H = 3600e3;
  const s = { total: joined.size, waiting: 0, brochure: 0, video: 0, lists };
  for (const t of joined.values()) { const age = now - t; if (age < H) s.waiting++; else if (age < 49 * H) s.brochure++; else s.video++; }
  return s;
}

export async function dailyEmailData(day) {
  const P = [cfg.tz, day];
  const onDay = (col) => `(${col} AT TIME ZONE $1)::date = $2::date`;
  const bySite = async (sql) => Object.fromEntries((await all(sql, P)).map(r => [r.site, r.n]));
  const sent = await bySite(`SELECT c.site, count(*)::int n FROM sends s JOIN campaigns c ON c.id=s.campaign_id WHERE s.status<>'failed' AND ${onDay("s.sent_at")} GROUP BY 1`);
  const opened = await bySite(`SELECT c.site, count(DISTINCT e.contact_id)::int n FROM events e JOIN sends s ON s.id=e.send_id JOIN campaigns c ON c.id=s.campaign_id WHERE e.type='open' AND ${onDay("e.created_at")} GROUP BY 1`);
  const clicks = await bySite(`SELECT c.site, count(DISTINCT e.contact_id)::int n FROM events e JOIN sends s ON s.id=e.send_id JOIN campaigns c ON c.id=s.campaign_id WHERE e.type='click' AND ${onDay("e.created_at")} GROUP BY 1`);
  const siteOf = `COALESCE((SELECT c.site FROM sends s JOIN campaigns c ON c.id=s.campaign_id WHERE s.contact_id=ct.id ORDER BY s.sent_at LIMIT 1), 'marketwatcher')`;
  const unsubs = await bySite(`SELECT ${siteOf} site, count(DISTINCT ct.id)::int n FROM events e JOIN contacts ct ON ct.id=e.contact_id WHERE e.type='unsubscribe' AND ${onDay("e.created_at")} GROUP BY 1`);
  const forms = await bySite(`SELECT ${siteOf} site, count(*)::int n FROM contacts ct WHERE ct.converted_at IS NOT NULL AND ${onDay("ct.converted_at")} GROUP BY 1`);
  // Replies: one row per person who replied that day (mailer inbox + Instantly), with whether it was an opt-out.
  const replies = await all(`SELECT ct.email, ct.first_name, ct.last_name, ${siteOf} site, max(e.detail) subject,
      bool_or(EXISTS (SELECT 1 FROM events u WHERE u.contact_id=ct.id AND u.type='unsubscribe' AND u.detail LIKE '%opt-out%')) opted_out
    FROM events e JOIN contacts ct ON ct.id=e.contact_id WHERE e.type='reply' AND ${onDay("e.created_at")} GROUP BY ct.id ORDER BY 1`, P);
  const inst = await instantlyDay(day);
  const brands = Object.fromEntries(BRANDS.map(b => [b, {
    sent: (sent[b] || 0) + inst[b].sent, opened: (opened[b] || 0) + inst[b].opened, clicks: (clicks[b] || 0) + inst[b].clicks,
    replies: replies.filter(r => r.site === b).length, unsubs: unsubs[b] || 0, forms: forms[b] || 0,
  }]));
  const total = Object.fromEntries(Object.keys(brands.marketwatcher).map(k => [k, BRANDS.reduce((a, b) => a + brands[b][k], 0)]));
  return { day, brands, total, replies, stages: await brochureStages(day) };
}

// ---- internal extras (Rob's copy): what each reply said + today's sending limit ----------------
async function replyTexts(day) {
  const P = [cfg.tz, day];
  const mailer = await all(`SELECT r.from_email email, r.snippet text, r.received_at at, COALESCE(c.site,'investchronicles') site
    FROM replies r LEFT JOIN sends s ON s.id=r.send_id LEFT JOIN campaigns c ON c.id=s.campaign_id
    WHERE NOT r.is_bounce AND (r.received_at AT TIME ZONE $1)::date=$2::date ORDER BY r.received_at`, P);
  const out = mailer.map(r => ({ email: r.email, site: r.site, text: replyOnly(r.text), subject: "" }));
  const key = process.env.INSTANTLY_REPORT_API_KEY;
  const camps = String(process.env.INSTANTLY_REPORT_CAMPAIGNS || "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher").split(",").map(s => s.trim()).filter(Boolean);
  for (const c of camps) {
    const [id, site = "marketwatcher"] = c.split(":");
    try {
      const r = await fetch(`https://api.instantly.ai/api/v2/emails?campaign_id=${encodeURIComponent(id)}&email_type=received&limit=100`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) continue;
      for (const e of (await r.json()).items || []) {
        const when = new Date(e.timestamp_email || e.timestamp_created);
        if (when.toLocaleDateString("en-CA", { timeZone: cfg.tz }) !== day) continue;
        out.push({ email: String(e.lead || e.from_address_email || ""), site, subject: e.subject || "", text: replyOnly(e.body?.text || e.content_preview || "") });
      }
    } catch {}
  }
  return out;
}

async function capacityToday() {
  const { allowances } = await import("./sender.js");
  const { total, allowances: al } = await allowances();
  const mailer = Math.min(total, [...al.values()].reduce((a, b) => a + Math.max(0, b - 3), 0));
  let instantly = 0;
  const key = process.env.INSTANTLY_REPORT_API_KEY;
  for (const c of String(process.env.INSTANTLY_REPORT_CAMPAIGNS || "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher").split(",").map(s => s.trim()).filter(Boolean)) {
    try {
      const j = await (await fetch(`https://api.instantly.ai/api/v2/campaigns/${encodeURIComponent(c.split(":")[0])}`, { headers: { Authorization: `Bearer ${key}` } })).json();
      if (j.status === 1) instantly += Number(j.daily_limit || 0);
    } catch {}
  }
  return { mailer, instantly, total: mailer + instantly };
}

export async function renderDailyEmail(day, { internal = false } = {}) {
  const d = await dailyEmailData(day);
  const t = d.total;
  const nice = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const subject = `Email campaign report – ${nice}: ${n(t.sent)} sent, ${n(t.opened)} opened, ${n(t.replies)} ${t.replies === 1 ? "reply" : "replies"}`;
  const sans = "Helvetica,Arial,sans-serif";
  const td = (x, bold) => `<td align="right" style="padding:8px 6px;border-bottom:1px solid #eee;font:${bold ? "700 " : ""}14px ${sans}">${x}</td>`;
  const row = (name, b, bold) => `<tr><td style="padding:8px 6px;border-bottom:1px solid #eee;font:${bold ? "700 " : ""}14px ${sans}">${h(name)}</td>${td(n(b.sent), bold)}${td(`${n(b.opened)} (${pct(b.opened, b.sent)})`, bold)}${td(n(b.clicks), bold)}${td(n(b.replies), bold)}${td(n(b.unsubs), bold)}${td(n(b.forms), bold)}</tr>`;
  const th = (x, left) => `<th align="${left ? "left" : "right"}" style="padding:8px 6px;border-bottom:2px solid #ddd;font:600 12px ${sans};color:#666">${x}</th>`;
  const optOuts = d.replies.filter(r => r.opted_out), others = d.replies.filter(r => !r.opted_out);
  const who = (r) => h([r.first_name, r.last_name].filter(Boolean).join(" ") || r.email) + ` (${h(r.email)}, ${h(BRAND_LABEL[r.site] || r.site)})`;
  const replyHtml = !d.replies.length ? `<p style="font:14px ${sans}">No replies.</p>` : `<ul style="font:14px/1.5 ${sans}">
${others.map(r => `<li>${who(r)}</li>`).join("\n")}
${optOuts.length ? `<li>${optOuts.length} asked not to be contacted again and ${optOuts.length === 1 ? "has" : "have"} been removed from all future emails automatically.</li>` : ""}
</ul>`;
  const s = d.stages;
  const stageHtml = !s ? "" : `<h3 style="font:600 16px ${sans};margin:22px 0 6px">Brochure follow-up (HubSpot)</h3>
<p style="font:14px ${sans};margin:0 0 6px">Everyone who opens or clicks is added to HubSpot and sent the brochure, then the video email two days later.</p>
<ul style="font:14px/1.5 ${sans}">
<li><b>${n(s.total)}</b> contacts in the follow-up so far</li>
<li><b>${n(s.waiting)}</b> about to receive the brochure</li>
<li><b>${n(s.brochure)}</b> have received the brochure and are due the video email next</li>
<li><b>${n(s.video)}</b> have received both the brochure and the video</li>
</ul>`;
  // Client version (Rob, 23 Nov 2026: "a simple email with basic stats"): headline numbers only, no names, no tables.
  if (!internal) {
    const li = (label, value) => `<tr><td style="padding:6px 16px 6px 0;font:15px ${sans};color:#555">${label}</td><td style="padding:6px 0;font:600 15px ${sans}">${value}</td></tr>`;
    const brandLine = BRANDS.map(b => { const x = d.brands[b]; return `${h(BRAND_LABEL[b])}: ${n(x.sent)} sent, ${n(x.opened)} opened`; }).join("<br>");
    const listRows = s?.lists ? BROCHURE_LISTS.filter(id => s.lists[id]).map(id => { const [kind, site] = LIST_LABEL[id]; const x = s.lists[id];
      return { label: `${kind} – ${BRAND_LABEL[site] || site}`, total: x.total, added: x.added }; }) : [];
    const listsHtml = listRows.length ? `<p style="font:600 15px ${sans};margin:20px 0 4px">HubSpot lists (running total)</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${listRows.map(r => li(h(r.label), `${n(r.total)}${r.added ? ` <span style="font-weight:400;color:#2a7a3b">(+${n(r.added)})</span>` : ""}`)).join("\n")}
</table>` : "";
    const followUp = s ? `<p style="font:15px/1.5 ${sans};margin:18px 0 0">Brochure follow-up: <b>${n(s.brochure + s.video)}</b> people have been sent the brochure so far${s.waiting ? `, and ${n(s.waiting)} more are about to receive it` : ""}.</p>` : "";
    const htmlSimple = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:#ffffff;color:#191714"><div style="max-width:560px">
<p style="font:15px/1.5 ${sans};margin:0 0 14px">Hi Mike,</p>
<p style="font:15px/1.5 ${sans};margin:0 0 10px">Here are the email figures for ${h(nice)}:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${li("Emails sent", n(t.sent))}
${li("Opened", `${n(t.opened)} (${pct(t.opened, t.sent)})`)}
${li("Clicks", n(t.clicks))}
${li("Replies", n(t.replies))}
${li("Form fills", n(t.forms))}
${li("Unsubscribes", n(t.unsubs))}
</table>
<p style="font:13px/1.6 ${sans};color:#777;margin:14px 0 0">${brandLine}</p>
${listsHtml}
${followUp}
</div></body></html>`;
    const textSimple = [`Hi Mike,`, ``, `Here are the email figures for ${nice}:`, ``,
      `Emails sent: ${t.sent}`, `Opened: ${t.opened} (${pct(t.opened, t.sent)})`, `Clicks: ${t.clicks}`, `Replies: ${t.replies}`, `Form fills: ${t.forms}`, `Unsubscribes: ${t.unsubs}`, ``,
      ...BRANDS.map(b => `${BRAND_LABEL[b]}: ${d.brands[b].sent} sent, ${d.brands[b].opened} opened`),
      ...(listRows.length ? ["", "HubSpot lists (running total):", ...listRows.map(r => `${r.label}: ${r.total}${r.added ? ` (+${r.added})` : ""}`)] : []),
      s ? `\nBrochure follow-up: ${s.brochure + s.video} people have been sent the brochure so far${s.waiting ? `, and ${s.waiting} more are about to receive it` : ""}.` : ""].join("\n");
    return { subject: `Daily email report – ${nice}`, html: htmlSimple, text: textSimple, totalSent: t.sent };
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:#ffffff;color:#191714">
<div style="max-width:680px">
<h2 style="font:600 20px ${sans};margin:0 0 4px">Email campaign report – ${h(nice)}</h2>
<p style="font:15px ${sans};margin:0 0 14px"><b>${n(t.sent)} emails sent · ${n(t.opened)} opened (${pct(t.opened, t.sent)}) · ${n(t.clicks)} ${t.clicks === 1 ? "click" : "clicks"} · ${n(t.replies)} ${t.replies === 1 ? "reply" : "replies"} · ${n(t.forms)} form ${t.forms === 1 ? "fill" : "fills"}</b></p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
<tr>${th("Brand", true)}${th("Sent")}${th("Opened")}${th("Clicks")}${th("Replies")}${th("Unsubscribes")}${th("Form fills")}</tr>
${BRANDS.map(b => row(BRAND_LABEL[b], d.brands[b])).join("\n")}
${row("Total", t, true)}
</table>
<h3 style="font:600 16px ${sans};margin:22px 0 6px">Replies</h3>
${replyHtml}
${stageHtml}
${internal ? await internalHtml(day, sans) : ""}
</div></body></html>`;
  const text = [`Email campaign report – ${nice}`, "",
    ...BRANDS.map(b => { const x = d.brands[b]; return `${BRAND_LABEL[b]}: ${x.sent} sent, ${x.opened} opened, ${x.clicks} clicks, ${x.replies} replies, ${x.unsubs} unsubscribes, ${x.forms} form fills`; }),
    `Total: ${t.sent} sent, ${t.opened} opened, ${t.clicks} clicks, ${t.replies} replies, ${t.unsubs} unsubscribes, ${t.forms} form fills`,
    s ? `\nBrochure follow-up: ${s.total} contacts; ${s.waiting} about to get the brochure, ${s.brochure} due the video, ${s.video} sent both.` : ""].join("\n");
  return { subject: internal ? `[Internal] ${subject}` : subject, html, text, totalSent: t.sent };
}

async function autopilotHtml(sans) {
  const st = JSON.parse(await getSetting("autopilot_status", "null") || "null");
  const since = Date.now() - 26 * 3600e3;
  const log = JSON.parse(await getSetting("autopilot_log", "[]") || "[]").filter(x => Date.parse(x.at + "Z") > since);
  if (!st && !log.length) return "";
  return `<h3 style="font:600 16px ${sans};margin:18px 0 6px">Autopilot (checks 07:00, 11:00, 15:00, 19:00)</h3>
<ul style="font:14px/1.5 ${sans}">${log.length ? log.map(x => `<li>${h(x.at.slice(11))} UTC: ${h(x.a)}</li>`).join("") : "<li>No changes needed in the last day.</li>"}
${(st?.notes || []).map(t => `<li style="color:#555">${h(t)}</li>`).join("")}</ul>`;
}

async function internalHtml(day, sans) {
  const [texts, cap] = await Promise.all([replyTexts(day).catch(() => []), capacityToday().catch(() => null)]);
  const li = texts.map(r => `<li><b>${h(r.email)}</b> (${h(BRAND_LABEL[r.site] || r.site)})${isOptOut(r.text, r.subject) ? " – <i>removed</i>" : ""}${/^(automatic reply|auto|out of office)/i.test(r.subject) ? " – <i>auto-reply</i>" : ""}: “${h(r.text.replace(/\s+/g, " ").slice(0, 280))}”</li>`).join("\n");
  return `<hr style="margin:26px 0 10px;border:0;border-top:1px solid #ddd">
<p style="font:600 12px ${sans};color:#999;letter-spacing:.08em;text-transform:uppercase">Internal – not in the client email</p>
<h3 style="font:600 16px ${sans};margin:10px 0 6px">What the replies said</h3>
${li ? `<ul style="font:14px/1.5 ${sans}">${li}</ul>` : `<p style="font:14px ${sans}">No replies.</p>`}
${Object.keys(bounceWatchState.campaigns).length ? `<h3 style="font:600 16px ${sans};margin:18px 0 6px">Instantly bounces (last 24h)</h3>
<ul style="font:14px/1.5 ${sans}">${Object.values(bounceWatchState.campaigns).map(c => `<li>${h(c.name)} – ${h(c.status)}: ${c.bounced24} of ${c.sent24} bounced (${c.rate24}%)${c.rate24 >= 2 ? " ⚠" : ""}; all time ${c.total}%</li>`).join("")}</ul>` : ""}
${await autopilotHtml(sans)}
${cap ? `<h3 style="font:600 16px ${sans};margin:18px 0 6px">Sending limit today</h3>
<p style="font:14px ${sans}">About <b>${n(cap.total)}</b> emails: mailer ${n(cap.mailer)}, Instantly ${n(cap.instantly)}.</p>` : ""}`;
}
