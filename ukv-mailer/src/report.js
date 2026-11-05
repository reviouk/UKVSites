/**
 * Client reporting: one data source (dailyReport) feeding
 *   - the client page   GET /report/:token   (REPORT_TOKEN; 404 when unset)
 *   - the morning email covering the previous day's sending (REPORT_EMAIL_ENABLED, off by default)
 *
 * Figures are per BRAND (Invest Chronicles / Market Watcher), combining our own sends with any
 * Instantly campaigns listed in INSTANTLY_REPORT_CAMPAIGNS ("<campaignId>:<site>,..."), read with
 * INSTANTLY_REPORT_API_KEY. The client-facing output never names the sending tool.
 *
 * Env:
 *   REPORT_TOKEN               secret for the client page URL
 *   REPORT_BASE_URL            host for report links (default BASE_URL)
 *   REPORT_EMAIL_ENABLED       "true" to send the morning email (default false)
 *   REPORT_EMAIL_TO / _CC      comma-separated recipients
 *   REPORT_EMAIL_TIME          local send time, default 07:30 (TIMEZONE)
 *   REPORT_SMTP_HOST/PORT/USER/PASS, REPORT_FROM ("Name <addr>", default REPORT_SMTP_USER)
 *   REPORT_SINCE               first day shown in "since launch" totals, default 2026-11-01
 */
import nodemailer from "nodemailer";
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { cfg, SITES, nowLocal } from "./config.js";
import { all, getSetting, setSetting } from "./db.js";
import { escapeHtml as h } from "./templates.js";

const env = (k, d = "") => process.env[k] ?? d;
export const reportCfg = {
  token: env("REPORT_TOKEN"),
  // Host used in report links (any domain pointing at this service), e.g. https://go.investchronicles.com
  baseUrl: (env("REPORT_BASE_URL") || cfg.baseUrl).replace(/\/$/, ""),
  emailEnabled: env("REPORT_EMAIL_ENABLED", "false").toLowerCase() === "true",
  to: env("REPORT_EMAIL_TO").split(",").map(s => s.trim()).filter(Boolean),
  cc: env("REPORT_EMAIL_CC").split(",").map(s => s.trim()).filter(Boolean),
  time: env("REPORT_EMAIL_TIME", "07:30"),
  smtp: { host: env("REPORT_SMTP_HOST"), port: Number(env("REPORT_SMTP_PORT", 465)), user: env("REPORT_SMTP_USER"), pass: env("REPORT_SMTP_PASS") },
  from: env("REPORT_FROM") || env("REPORT_SMTP_USER"),
  since: env("REPORT_SINCE", "2026-11-01"),
  instantlyKey: env("INSTANTLY_REPORT_API_KEY"),
  instantlyCampaigns: env("INSTANTLY_REPORT_CAMPAIGNS", "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher")
    .split(",").map(s => s.trim()).filter(Boolean).map(s => { const [id, site] = s.split(":"); return { id, site: site || "marketwatcher" }; }),
};
export const reportState = { lastRun: null, lastResult: "" };

const BRANDS = ["investchronicles", "marketwatcher"];
const METRICS = ["sent", "bounced", "replies", "clicks", "unsubscribes", "enquiries"];
const blank = () => Object.fromEntries(METRICS.map(m => [m, 0]));

// ---- dates --------------------------------------------------------------------
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const todayKey = () => nowLocal().dateKey;
export const yesterdayKey = () => addDays(todayKey(), -1);
const nice = (key, opts = { weekday: "short", day: "numeric", month: "short" }) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });

// ---- our own sending ----------------------------------------------------------
async function appDaily(from, to) {
  const tz = cfg.tz, P = [tz, from, to];
  const day = (col) => `to_char(${col} AT TIME ZONE $1, 'YYYY-MM-DD') AS day`;
  const inRange = (col) => `(${col} AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
  const rows = [];
  const push = (metric, list) => list.forEach(r => rows.push({ metric, day: r.day, site: r.site, n: r.n }));
  push("sent", await all(`SELECT ${day("s.sent_at")}, c.site, count(*)::int n FROM sends s JOIN campaigns c ON c.id=s.campaign_id
    WHERE s.status<>'failed' AND ${inRange("s.sent_at")} GROUP BY 1,2`, P));
  push("bounced", await all(`SELECT ${day("s.sent_at")}, c.site, count(*)::int n FROM sends s JOIN campaigns c ON c.id=s.campaign_id
    WHERE s.status='bounced' AND ${inRange("s.sent_at")} GROUP BY 1,2`, P));
  push("clicks", await all(`SELECT ${day("s.clicked_at")}, c.site, count(*)::int n FROM sends s JOIN campaigns c ON c.id=s.campaign_id
    WHERE s.clicked_at IS NOT NULL AND ${inRange("s.clicked_at")} GROUP BY 1,2`, P));
  push("replies", await all(`SELECT ${day("r.received_at")}, c.site, count(DISTINCT COALESCE(r.contact_id, r.id))::int n
    FROM replies r JOIN sends s ON s.id=r.send_id JOIN campaigns c ON c.id=s.campaign_id
    WHERE NOT r.is_bounce AND ${inRange("r.received_at")} GROUP BY 1,2`, P));
  push("unsubscribes", await all(`SELECT ${day("e.created_at")}, c.site, count(DISTINCT e.contact_id)::int n
    FROM events e JOIN sends s ON s.id=e.send_id JOIN campaigns c ON c.id=s.campaign_id
    WHERE e.type='unsubscribe' AND ${inRange("e.created_at")} GROUP BY 1,2`, P));
  // Website enquiries = HubSpot form fills after our first email (see conversions.js). Brand = the
  // campaign that emailed them; contacts only emailed via an outside campaign count as Market Watcher.
  push("enquiries", await all(`SELECT ${day("ct.converted_at")},
      COALESCE((SELECT c.site FROM sends s JOIN campaigns c ON c.id=s.campaign_id WHERE s.contact_id=ct.id ORDER BY s.sent_at LIMIT 1), 'marketwatcher') site,
      count(*)::int n FROM contacts ct WHERE ct.converted_at IS NOT NULL AND ${inRange("ct.converted_at")} GROUP BY 1,2`, P));
  return rows;
}

// ---- Instantly campaigns (cached 15 min) ----------------------------------------
let instCache = { key: "", at: 0, rows: [], error: "" };
async function instantlyDaily(from, to) {
  if (!reportCfg.instantlyKey || !reportCfg.instantlyCampaigns.length) return { rows: [], connected: false, error: "" };
  const cacheKey = `${from}|${to}`;
  if (instCache.key === cacheKey && Date.now() - instCache.at < 15 * 60_000) return { rows: instCache.rows, connected: !instCache.error, error: instCache.error };
  const rows = [];
  let error = "";
  for (const { id, site } of reportCfg.instantlyCampaigns) {
    try {
      const r = await fetch(`https://api.instantly.ai/api/v2/campaigns/analytics/daily?campaign_id=${encodeURIComponent(id)}&start_date=${from}&end_date=${to}`,
        { headers: { Authorization: `Bearer ${reportCfg.instantlyKey}` } });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
      const body = await r.json();
      for (const d of (Array.isArray(body) ? body : body.items || [])) {
        const day = String(d.date || "").slice(0, 10);
        if (!day) continue;
        rows.push({ metric: "sent", day, site, n: Number(d.sent || 0) });
        rows.push({ metric: "replies", day, site, n: Number(d.unique_replies ?? d.replies ?? 0) });
        rows.push({ metric: "clicks", day, site, n: Number(d.unique_clicks ?? d.clicks ?? 0) });
        if (d.bounced != null) rows.push({ metric: "bounced", day, site, n: Number(d.bounced) });
      }
    } catch (e) { error = e.message; console.warn("[report] instantly", id, e.message); }
  }
  instCache = { key: cacheKey, at: Date.now(), rows, error };
  return { rows, connected: !error, error };
}

/**
 * Daily figures per brand between two local dates (inclusive):
 * { days: [{ day, brands: { site: {sent,...} }, total: {...} }] (newest first), totals: {site:{...}, all:{...}}, outside }
 */
export async function dailyReport(from, to) {
  const [app, inst] = await Promise.all([appDaily(from, to), instantlyDaily(from, to)]);
  const byDay = new Map();
  for (let d = to; d >= from; d = addDays(d, -1)) byDay.set(d, { day: d, brands: Object.fromEntries(BRANDS.map(b => [b, blank()])), total: blank() });
  const totals = { ...Object.fromEntries(BRANDS.map(b => [b, blank()])), all: blank() };
  for (const r of [...app, ...inst.rows]) {
    const row = byDay.get(r.day);
    if (!row || !METRICS.includes(r.metric)) continue;
    const site = BRANDS.includes(r.site) ? r.site : "marketwatcher";
    row.brands[site][r.metric] += r.n; row.total[r.metric] += r.n;
    totals[site][r.metric] += r.n; totals.all[r.metric] += r.n;
  }
  return { from, to, days: [...byDay.values()], totals, outside: { connected: inst.connected, configured: !!reportCfg.instantlyKey, error: inst.error } };
}

// ---- rendering ------------------------------------------------------------------
const label = (site) => SITES[site]?.label === "The Invest Chronicle" ? "Invest Chronicles" : (SITES[site]?.label || site);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const n = (x) => Number(x || 0).toLocaleString("en-GB");

const COLS = { sent: "Sent", bounced: "Bounced", replies: "Replies", clicks: "Link clicks", unsubscribes: "Unsubscribed", enquiries: "Enquiries" };
function brandTable(t, style, keys = Object.keys(COLS)) {
  const head = ["", ...keys.map(k => COLS[k])];
  const row = (name, m, bold) => `<tr${bold ? ` style="font-weight:600;${style.totalRow}"` : ""}><td style="${style.td}text-align:left">${h(name)}</td>${
    keys.map(k => `<td style="${style.td}">${n(m[k])}</td>`).join("")}</tr>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="${style.table}">
<tr>${head.map((x, i) => `<th style="${style.th}${i ? "" : "text-align:left"}">${x}</th>`).join("")}</tr>
${BRANDS.map(b => row(label(b), t[b])).join("")}${row("Total", t.all || t.total, true)}</table>`;
}

const pageStyle = {
  table: "border-collapse:collapse;width:100%;background:#fff;font-size:14px",
  th: "padding:8px 10px;border-bottom:2px solid #d9dee4;text-align:right;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6775;font-weight:600;white-space:nowrap;",
  td: "padding:8px 10px;border-bottom:1px solid #eef0f2;text-align:right;white-space:nowrap;",
  totalRow: "background:#f6f7f9;",
};

function notes(r) {
  const list = [
    "Open tracking is switched off on purpose: tracking pixels push cold email towards spam folders and open figures are unreliable (Apple Mail and corporate filters auto-load images). Replies, link clicks and website enquiries are the measures that matter.",
    "Enquiries are HubSpot form submissions made by people we emailed, after the email reached them. They are checked hourly.",
    "Replies exclude bounces and out-of-office auto-replies where these can be recognised.",
  ];
  if (!r.outside.connected) list.push(r.outside.configured
    ? "Some Market Watcher figures could not be loaded just now and will appear on the next refresh."
    : "Market Watcher figures from the newest sending accounts are being connected and will appear here shortly.");
  return list;
}

export async function renderClientPage() {
  const to = todayKey(), from = addDays(to, -13);
  const [recent, launch] = await Promise.all([dailyReport(from, to), dailyReport(reportCfg.since, to)]);
  const y = recent.days.find(d => d.day === yesterdayKey());
  const t = recent.days[0];
  const card = (v, l, sub = "") => `<div class="card"><b>${v}</b><span>${l}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const all = launch.totals.all;
  const dayRows = recent.days.map(d => `<tr><td style="${pageStyle.td}text-align:left">${nice(d.day)}${d.day === to ? ' <span class="muted">(so far)</span>' : ""}</td>${
    BRANDS.map(b => `<td style="${pageStyle.td}">${n(d.brands[b].sent)}</td>`).join("")}<td style="${pageStyle.td}font-weight:600">${n(d.total.sent)}</td>${
    ["bounced", "replies", "clicks", "enquiries"].map(k => `<td style="${pageStyle.td}">${n(d.total[k])}</td>`).join("")}</tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Email campaign report</title>
<style>
:root{--ink:#1b2430;--muted:#6b7684;--line:#e3e6ea;--bg:#f6f7f9;--accent:#a8741a}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:#16202e;color:#fff;padding:20px 16px}header div{max-width:1000px;margin:0 auto}
header h1{margin:0;font-size:20px;font-weight:600}header p{margin:4px 0 0;color:#c5cfdb;font-size:13px}
main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}
h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:#fff;border:1px solid var(--line);padding:14px 16px}.card b{display:block;font-size:26px;font-weight:600}
.card span{color:var(--muted);font-size:13px}.card small{display:block;color:var(--muted);font-size:12px}
.scroll{overflow-x:auto;border:1px solid var(--line);background:#fff}.muted{color:var(--muted);font-size:12px}
ul{padding-left:18px;color:var(--muted);font-size:13px}footer{color:var(--muted);font-size:12px;margin-top:24px}
</style></head><body>
<header><div><h1>Email campaign report</h1><p>Invest Chronicles &amp; Market Watcher · updated ${h(new Date().toLocaleString("en-GB", { timeZone: cfg.tz, dateStyle: "medium", timeStyle: "short" }))}</p></div></header>
<main>
<h2>Since launch (${h(nice(reportCfg.since, { day: "numeric", month: "short", year: "numeric" }))})</h2>
<div class="cards">${card(n(all.sent), "Emails sent")}${card(n(all.replies), "Replies", pct(all.replies, all.sent) + " reply rate")}${card(n(all.clicks), "Link clicks")}${card(n(all.enquiries), "Website enquiries")}${card(pct(all.bounced, all.sent), "Bounce rate", n(all.bounced) + " bounced")}</div>
<div class="scroll" style="margin-top:12px">${brandTable(launch.totals, pageStyle)}</div>
<h2>Yesterday · ${h(nice(yesterdayKey()))}</h2>
${y ? `<div class="scroll">${brandTable({ ...y.brands, all: y.total }, pageStyle)}</div>` : ""}
<h2>Today so far · ${h(nice(to))}</h2>
<div class="scroll">${brandTable({ ...t.brands, all: t.total }, pageStyle)}</div>
<h2>Last 14 days</h2>
<div class="scroll"><table style="${pageStyle.table}"><tr><th style="${pageStyle.th}text-align:left">Day</th>${BRANDS.map(b => `<th style="${pageStyle.th}">${h(label(b))}</th>`).join("")}<th style="${pageStyle.th}">Total sent</th><th style="${pageStyle.th}">Bounced</th><th style="${pageStyle.th}">Replies</th><th style="${pageStyle.th}">Clicks</th><th style="${pageStyle.th}">Enquiries</th></tr>${dayRows}</table></div>
<h2>Notes</h2><ul>${notes(launch).map(x => `<li>${h(x)}</li>`).join("")}</ul>
<footer>Sending runs Monday to Friday, 08:00–17:30 UK time.</footer>
</main></body></html>`;
}

/** The morning email: the previous day's sending, plus totals since launch. */
export async function renderEmail(dayKey = yesterdayKey()) {
  const [d, launch] = await Promise.all([dailyReport(dayKey, dayKey), dailyReport(reportCfg.since, dayKey)]);
  const day = d.days[0];
  const s = { ...pageStyle, table: "border-collapse:collapse;width:100%;font-size:13px;background:#fff",
    th: pageStyle.th.replace("padding:8px 10px", "padding:6px 6px").replace("letter-spacing:.04em", "letter-spacing:0"), td: pageStyle.td.replace("padding:8px 10px", "padding:7px 6px") };
  const cols = ["sent", "replies", "clicks", "enquiries", "bounced"];
  const link = reportCfg.token ? `${reportCfg.baseUrl}/report/${encodeURIComponent(reportCfg.token)}` : "";
  const subject = `Email campaign report · ${nice(dayKey, { weekday: "long", day: "numeric", month: "long" })}: ${n(day.total.sent)} sent, ${n(day.total.replies)} ${day.total.replies === 1 ? "reply" : "replies"}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1b2430">
<div style="max-width:640px;margin:0 auto;padding:20px 16px">
<h1 style="font-size:18px;margin:0 0 4px">Email campaign report</h1>
<p style="margin:0 0 16px;color:#6b7684;font-size:13px">${h(nice(dayKey, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>
<p style="font-size:15px;margin:0 0 14px"><b>${n(day.total.sent)}</b> emails sent · <b>${n(day.total.replies)}</b> replies · <b>${n(day.total.clicks)}</b> link clicks · <b>${n(day.total.enquiries)}</b> website enquiries · ${pct(day.total.bounced, day.total.sent)} bounced</p>
${brandTable({ ...day.brands, all: day.total }, s, cols)}
<h2 style="font-size:14px;margin:22px 0 8px">Since launch (${h(nice(reportCfg.since, { day: "numeric", month: "short" }))})</h2>
${brandTable(launch.totals, s, cols)}
${link ? `<p style="margin:20px 0"><a href="${h(link)}" style="background:#16202e;color:#fff;padding:10px 16px;text-decoration:none;font-size:14px">View the full report</a></p>` : ""}
<p style="color:#6b7684;font-size:12px;margin-top:18px">${h(notes(launch)[0])}</p>
</div></body></html>`;
  const text = [`Email campaign report: ${nice(dayKey, { weekday: "long", day: "numeric", month: "long" })}`, "",
    ...BRANDS.map(b => `${label(b)}: ${n(day.brands[b].sent)} sent, ${n(day.brands[b].replies)} replies, ${n(day.brands[b].clicks)} clicks, ${n(day.brands[b].enquiries)} enquiries`),
    `Total: ${n(day.total.sent)} sent, ${n(day.total.replies)} replies, ${n(day.total.clicks)} clicks, ${n(day.total.enquiries)} enquiries, ${n(day.total.bounced)} bounced`,
    "", `Since launch: ${n(launch.totals.all.sent)} sent, ${n(launch.totals.all.replies)} replies, ${n(launch.totals.all.enquiries)} enquiries`,
    link ? `\nFull report: ${link}` : ""].join("\n");
  return { subject, html, text, totalSent: day.total.sent };
}

// ---- sending ----------------------------------------------------------------------
export function emailReady() {
  const missing = [];
  if (!reportCfg.to.length) missing.push("REPORT_EMAIL_TO");
  for (const k of ["host", "user", "pass"]) if (!reportCfg.smtp[k]) missing.push(`REPORT_SMTP_${k.toUpperCase()}`);
  return missing;
}

export async function sendReportEmail({ dayKey = yesterdayKey(), to = reportCfg.to, cc = reportCfg.cc } = {}) {
  const missing = emailReady().filter(k => k !== "REPORT_EMAIL_TO");
  if (missing.length) throw new Error(`Not configured: ${missing.join(", ")}`);
  if (!to.length) throw new Error("No recipients");
  const { subject, html, text } = await renderEmail(dayKey);
  const { host, port, user, pass } = reportCfg.smtp;
  const t = nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass }, connectionTimeout: 20000,
    tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined });
  try { await t.sendMail({ from: reportCfg.from, to, cc: cc.length ? cc : undefined, subject, html, text }); } finally { t.close(); }
  return { subject, to };
}

/** Every 10 min: once the local time passes REPORT_EMAIL_TIME, send yesterday's report (once per day, only if anything was sent). */
async function tick() {
  if (!reportCfg.emailEnabled) { reportState.lastResult = "disabled (REPORT_EMAIL_ENABLED is not true)"; return; }
  reportState.lastRun = new Date();
  const { minutes } = nowLocal();
  const [hh, mm] = reportCfg.time.split(":").map(Number);
  if (minutes < hh * 60 + (mm || 0)) return;
  const day = yesterdayKey();
  if ((await getSetting("report_email_last_day", "")) === day) return;
  const { totalSent } = await renderEmail(day);
  if (!totalSent) { await setSetting("report_email_last_day", day); reportState.lastResult = `${day}: nothing sent, no email`; return; }
  await sendReportEmail({ dayKey: day });
  await setSetting("report_email_last_day", day);
  reportState.lastResult = `${day}: sent to ${reportCfg.to.join(", ")}`;
  console.log(`[report] ${reportState.lastResult}`);
}

export function startReportEmails() {
  reportState.lastResult = reportCfg.emailEnabled ? "waiting" : "disabled (REPORT_EMAIL_ENABLED is not true)";
  if (!reportCfg.emailEnabled) return;
  const run = () => tick().catch(e => { reportState.lastResult = `error: ${e.message}`; console.warn("[report]", e.message); });
  setTimeout(run, 90_000);
  setInterval(run, 10 * 60_000);
}

// ---- public client page --------------------------------------------------------------
export const reportRoutes = Router();
const sameToken = (a) => {
  const b = Buffer.from(reportCfg.token), x = Buffer.from(String(a || ""));
  return reportCfg.token.length >= 16 && x.length === b.length && timingSafeEqual(x, b);
};
reportRoutes.get("/report/:token", async (req, res) => {
  if (!sameToken(req.params.token)) return res.status(404).send("Not found");
  try {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    res.send(await renderClientPage());
  } catch (e) { console.error("[report]", e); res.status(500).send("Report unavailable, please try again shortly."); }
});
