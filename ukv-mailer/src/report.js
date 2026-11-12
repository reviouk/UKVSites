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
 */
import nodemailer from "nodemailer";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router } from "express";
import { cfg, SITES, nowLocal } from "./config.js";
import { all, getSetting, setSetting } from "./db.js";
import { escapeHtml as h } from "./templates.js";

// UKV International logo (white + gold, for the dark banner), embedded so the page needs no static route.
let LOGO = "";
try { LOGO = "data:image/png;base64," + readFileSync(new URL("./assets/ukv-logo.png", import.meta.url)).toString("base64"); } catch {}
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


// ---- split-test variants (Invest Chronicles single-email campaign) ---------------------
/** Per-variant results for campaigns that send variants (sends.variant set). Earlier sends have variant NULL => "Earlier copy". */
export async function variantReport(dayKey) {
  const rows = await all(`
    SELECT c.site, COALESCE(s.variant, 'Earlier copy') AS variant,
           count(*)::int AS sent,
           count(*) FILTER (WHERE (s.sent_at AT TIME ZONE $1)::date = $2::date)::int AS sent_day,
           count(s.opened_at)::int AS opened, count(s.clicked_at)::int AS clicked, count(s.replied_at)::int AS replied
      FROM sends s JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.status <> 'failed' AND s.step_position = 1
       AND c.site = 'investchronicles'
       AND c.id IN (SELECT campaign_id FROM sends WHERE variant IS NOT NULL)
     GROUP BY 1, 2 ORDER BY 2`, [cfg.tz, dayKey]);
  return rows;
}
/** Market Watcher split test: first-email (step 0) results per variant from the outside sender, all reported campaigns summed. */
let instVarCache = { at: 0, rows: [] };
async function instantlyVariants() {
  if (!reportCfg.instantlyKey || !reportCfg.instantlyCampaigns.length) return [];
  if (Date.now() - instVarCache.at < 15 * 60_000) return instVarCache.rows;
  const agg = {};
  for (const { id } of reportCfg.instantlyCampaigns) {
    try {
      const r = await fetch(`https://api.instantly.ai/api/v2/campaigns/analytics/steps?campaign_id=${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${reportCfg.instantlyKey}` } });
      if (!r.ok) throw new Error(`${r.status}`);
      for (const s of await r.json()) {
        if (String(s.step) !== "0") continue;                       // first email only
        const v = "ABCDEFGHIJ"[Number(s.variant)] || String(s.variant);
        const a = (agg[v] ||= { variant: v, sent: 0, sent_day: null, opened: null, clicked: 0, replied: 0 });
        a.sent += Number(s.sent || 0); a.clicked += Number(s.unique_clicks || 0); a.replied += Number(s.unique_replies || 0);
      }
    } catch (e) { console.warn("[report] instantly variants", id, e.message); return instVarCache.rows; }
  }
  instVarCache = { at: Date.now(), rows: Object.values(agg).sort((x, y) => x.variant.localeCompare(y.variant)) };
  return instVarCache.rows;
}
/** Both brands' split-test tables (HTML), or "" when neither has data. */
async function variantSectionsHtml(dayKey) {
  const [ic, mw] = await Promise.all([variantReport(dayKey), instantlyVariants()]);
  return [variantTableHtml(ic, `Split test: ${label("investchronicles")} (first email, all time)`),
          variantTableHtml(mw, `Split test: ${label("marketwatcher")} (first email, all time)`)].filter(Boolean).join(`<div style="height:10px"></div>`);
}
function variantTableHtml(rows, title, { sans = "Helvetica,Arial,sans-serif" } = {}) {
  if (!rows.length) return "";
  const th = (x) => `<th align="right" style="padding:8px 6px;font:600 10px ${sans};letter-spacing:.06em;text-transform:uppercase;color:#857b6e;border-bottom:1px solid #e7dfd2">${x}</th>`;
  const cell = (x) => `<td align="right" style="padding:9px 6px;border-bottom:1px solid #f1ebe1;font:14px ${sans};color:#191714">${x == null ? "–" : n(x)}</td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffdf9;border:1px solid #e7dfd2;border-radius:10px">
<tr><th align="left" style="padding:8px 12px;font:600 10px ${sans};letter-spacing:.06em;text-transform:uppercase;color:#857b6e;border-bottom:1px solid #e7dfd2">${h(title)}</th>${th("Sent")}${th("Today")}${th("Opens")}${th("Clicks")}${th("Replies")}</tr>
${rows.map(r => `<tr><td style="padding:9px 12px;border-bottom:1px solid #f1ebe1;font:14px ${sans};color:#191714">${r.variant.length === 1 ? "Email " : ""}${h(r.variant)}</td>${[r.sent, r.sent_day, r.opened, r.clicked, r.replied].map(cell).join("")}</tr>`).join("")}</table>`;
}

// ---- rendering ------------------------------------------------------------------
const label = (site) => SITES[site]?.label === "The Invest Chronicle" ? "Invest Chronicles" : (SITES[site]?.label || site);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const n = (x) => Number(x || 0).toLocaleString("en-GB");

// Brand + metric palette, shared by the page and the email.
const BRAND_COLOR = { investchronicles: "#1f6f78", marketwatcher: "#c8892b" };
const METRIC = {
  sent:         { name: "Emails sent",       color: "#c8892b", tint: "#f8ecd8" },
  replies:      { name: "Replies",           color: "#2e7d4f", tint: "#dff0e5" },
  clicks:       { name: "Link clicks",       color: "#2c5fa8", tint: "#dfe8f6" },
  enquiries:    { name: "Form completions", color: "#8a3b6e", tint: "#f3e0ec" },
  bounced:      { name: "Bounced",           color: "#b5452f", tint: "#f8e1dc" },
  unsubscribes: { name: "Unsubscribed",      color: "#6b7280", tint: "#eceef1" },
};
// Line icons (24px grid, stroke = currentColor).
const ICON = {
  sent: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  replies: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  clicks: '<path d="m9 9 5 12 1.8-5.2L21 14 9 9z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>',
  enquiries: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3h6v3H9z"/><path d="m9 14 2 2 4-4"/>',
  bounced: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  unsubscribes: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const svg = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function notes(r) {
  const list = [
    "Open tracking is switched off on purpose: tracking pixels push cold email towards spam folders, and open figures are unreliable because Apple Mail and corporate filters load images automatically. Replies, link clicks and form completions are the measures that matter.",
    "Form completions are HubSpot website form submissions (enquiries, guide downloads, call-back requests) made by people we emailed, after the email reached them. Completion rate = form completions ÷ people who clicked through. Checked hourly.",
    "Replies exclude bounces and out-of-office auto-replies where these can be recognised.",
  ];
  if (!r.outside.connected) list.push(r.outside.configured
    ? "Some Market Watcher figures could not be loaded just now and will appear on the next refresh."
    : "Market Watcher figures from the newest sending accounts are being connected and will appear here shortly.");
  return list;
}

/**
 * Planned ramp to full volume, all brands, emails per day: one "YYYY-MM-DD: N" per line, each
 * holding until the next. Edited in Admin > Client report (setting report_ramp_plan).
 */
export const DEFAULT_RAMP_PLAN = `2026-11-01: 50
2026-11-05: 150
2026-11-06: 200
2026-11-16: 250
2026-11-30: 400
2026-12-07: 650
2026-12-14: 1000`;
export function parseRampPlan(text) {
  return String(text || "").split(/\r?\n/)
    .map(l => l.match(/^\s*(\d{4}-\d{2}-\d{2})\s*[:,=]?\s*(\d+)\s*$/)).filter(Boolean)
    .map(m => ({ day: m[1], v: Number(m[2]) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}
export async function rampPlan() { return parseRampPlan(await getSetting("report_ramp_plan", DEFAULT_RAMP_PLAN)); }

/** Client page: 90 days of daily figures embedded as JSON; filters (period, brand, chart metric) run in the browser. */
export async function renderClientPage() {
  const to = todayKey(), from = addDays(to, -89);
  const r = await dailyReport(from, to);
  const variantHtml = await variantSectionsHtml(to);
  const data = {
    today: to, yesterday: yesterdayKey(),
    brands: BRANDS.map(b => ({ key: b, name: label(b), color: BRAND_COLOR[b] })),
    metrics: Object.fromEntries(Object.entries(METRIC).map(([k, v]) => [k, { ...v, icon: svg(k, 20) }])),
    ramp: await rampPlan(),
    days: r.days.slice().reverse().map(d => ({ day: d.day, b: Object.fromEntries(BRANDS.map(b => [b, d.brands[b]])) })),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const updated = new Date().toLocaleString("en-GB", { timeZone: cfg.tz, dateStyle: "medium", timeStyle: "short" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>Campaign Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--ink:#191714;--ink2:#4a443c;--muted:#857b6e;--line:#e7dfd2;--paper:#f7f3ec;--card:#fffdf9;--peat:#16130f;--amber:#c8892b;--teal:#1f6f78;
--serif:"Fraunces",Georgia,serif;--sans:"Hanken Grotesk",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
.num{font-family:var(--serif);font-variant-numeric:tabular-nums lining-nums;font-weight:600;letter-spacing:-.01em}
header{position:relative;overflow:hidden;color:#f3eadb;background:
 radial-gradient(900px 300px at 85% -40%,rgba(200,137,43,.38),transparent 60%),
 radial-gradient(700px 260px at 0% 120%,rgba(31,111,120,.35),transparent 60%),var(--peat)}
header::after{content:"";position:absolute;inset:0;opacity:.07;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.head{position:relative;z-index:1;padding-top:34px;padding-bottom:30px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.logo{display:block;height:58px;width:auto;margin-bottom:16px}
.eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#d9b77c}
h1{font-family:var(--serif);font-weight:400;font-size:clamp(28px,5vw,40px);line-height:1.1;margin:6px 0 6px}
.brands-line{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:#cfc3ae}
.brands-line i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.updated{font-size:12px;color:#a99c86;text-align:right}
/* filters */
.filters{position:sticky;top:0;z-index:5;background:rgba(247,243,236,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.filters .wrap{display:flex;gap:10px 18px;align-items:center;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}
.fgroup{display:flex;align-items:center;gap:8px;color:var(--muted);min-width:0;max-width:100%}
.seg{display:inline-flex;background:#ece5d9;border-radius:999px;padding:3px;max-width:100%;overflow-x:auto;scrollbar-width:none}.seg::-webkit-scrollbar{display:none}
.seg button{border:0;background:transparent;font:500 13px var(--sans);color:var(--ink2);padding:6px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.seg button[aria-pressed=true]{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--line)}
.seg button:focus-visible,.dates input:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.dates{display:none;gap:6px;align-items:center;font-size:13px}.dates.on{display:flex}
.dates input{font:13px var(--sans);padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
main{padding:26px 0 56px}
.period{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.period h2{font-family:var(--serif);font-weight:400;font-size:22px;margin:0}
.period span{color:var(--muted);font-size:13px}
/* KPI cards */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 16px 14px;position:relative;overflow:hidden;animation:rise .5s both}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c)}
.kpi .ic{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--t);color:var(--c);margin-bottom:12px}
.kpi .v{font-size:34px;line-height:1}
.kpi .l{color:var(--ink2);font-size:13px;margin-top:6px}
.kpi .s{color:var(--muted);font-size:12px;margin-top:2px;min-height:18px}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
section{margin-top:28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.sec-h{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.sec-h h3{margin:0;font:600 13px var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
/* brand split */
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.brand{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;border-top:4px solid var(--bc)}
.brand .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.brand .nm{font-family:var(--serif);font-size:20px}
.brand .big{font-size:28px}
.share{height:6px;background:#efe8dc;border-radius:99px;margin:12px 0 14px;overflow:hidden}.share i{display:block;height:100%;background:var(--bc);border-radius:99px;transition:width .5s}
.rows{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
.row svg{color:var(--c);flex:none}.row b{margin-left:auto;font-family:var(--serif);font-weight:600;color:var(--ink);font-size:15px}
/* chart */
.chart{width:100%;height:240px;display:block}
.chart .grid{stroke:#eee6d8}.chart text{font:11px var(--sans);fill:var(--muted)}
.chart rect.bar{transition:opacity .15s}.chart g.col:hover rect.bar{opacity:.8}
.ramp{height:260px}.ramp .plan{fill:none;stroke:var(--ink);stroke-width:2;stroke-dasharray:6 5;stroke-linejoin:round}
.ramp .plan.done{stroke-dasharray:none;opacity:.55}.ramp .today{stroke:var(--amber);stroke-width:1.5}.ramp text.tl{fill:var(--amber);font-weight:600}
.ramp text.goal{fill:var(--ink);font-weight:600;font-size:12px}
.rampnow{font-size:13px;color:var(--ink2)}.rampnow b{font-family:var(--serif);font-weight:600;font-size:16px;color:var(--ink)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--ink2);flex-wrap:wrap}
.empty{fill:var(--muted);font:13px var(--sans)}
/* table */
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th{font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:right;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
td{padding:9px 10px;border-bottom:1px solid #f1ebe1;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.zero td{color:#b3a999}tr.tot td{font-weight:600;border-top:2px solid var(--line);border-bottom:0}
td .chip{display:inline-block;min-width:22px;padding:1px 7px;border-radius:99px;background:var(--t);color:var(--c);font-weight:600}
.notes{display:grid;gap:8px;font-size:13px;color:var(--ink2)}.notes p{margin:0;display:flex;gap:10px}.notes svg{color:var(--muted);flex:none;margin-top:2px}
footer{color:var(--muted);font-size:12px;margin-top:26px;text-align:center}
@media (max-width:560px){.kpi .v{font-size:28px}.kpis{grid-template-columns:1fr 1fr}.rows{grid-template-columns:1fr}.head{padding-top:26px;padding-bottom:22px}.logo{height:46px;margin-bottom:12px}.updated{text-align:left}.filters{position:static}.filters .wrap{gap:8px}.fgroup{width:100%}.seg button{padding:6px 10px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header><div class="wrap head">
 <div>${LOGO ? `<img class="logo" src="${LOGO}" alt="UKV International">` : ""}<div class="eyebrow">Email campaign report</div><h1>Outreach performance</h1>
 <div class="brands-line">${data.brands.map(b => `<span><i style="background:${b.color}"></i>${h(b.name)}</span>`).join("")}</div></div>
 <div class="updated">Updated ${h(updated)}<br>Figures refresh every time this page is opened</div>
</div></header>
<div class="filters"><div class="wrap">
 <div class="fgroup">${svg("calendar", 16)}<div class="seg" id="range" role="group" aria-label="Period">
  <button data-r="today">Today</button><button data-r="yesterday">Yesterday</button><button data-r="7">7 days</button><button data-r="14">14 days</button><button data-r="30">30 days</button><button data-r="month">This month</button><button data-r="custom">Custom</button></div></div>
 <div class="dates" id="dates"><input type="date" id="dfrom" aria-label="From"> to <input type="date" id="dto" aria-label="To"></div>
 <div class="fgroup">${svg("layers", 16)}<div class="seg" id="brand" role="group" aria-label="Brand">
  <button data-b="all">All brands</button>${data.brands.map(b => `<button data-b="${b.key}"><span class="dot" style="background:${b.color}"></span>${h(b.name)}</button>`).join("")}</div></div>
</div></div>
<main class="wrap">
 <div class="period"><h2 id="ptitle"></h2><span id="psub"></span></div>
 <div class="kpis" id="kpis"></div>
 <section class="card" id="rampcard"><div class="sec-h"><h3>${svg("trend", 16)}Ramp-up to full volume</h3><span class="rampnow" id="rampnow"></span></div>
  <svg class="chart ramp" id="ramp" role="img" aria-label="Emails sent per day against the planned ramp-up"></svg><div class="legend" id="ramplegend"></div></section>
 <section><div class="sec-h"><h3>By brand</h3></div><div class="split" id="split"></div></section>
 <section class="card"><div class="sec-h"><h3>Daily trend</h3><div class="seg" id="metric" role="group" aria-label="Chart metric">
  <button data-m="sent">Sent</button><button data-m="replies">Replies</button><button data-m="clicks">Clicks</button><button data-m="enquiries">Form completions</button><button data-m="bounced">Bounces</button></div></div>
  <svg class="chart" id="chart" role="img" aria-label="Daily chart"></svg><div class="legend" id="legend"></div></section>
 ${variantHtml ? `<section class="card"><div class="sec-h"><h3>Email variants</h3></div>${variantHtml}</section>` : ""}
 <section class="card"><div class="sec-h"><h3>Day by day</h3></div><div class="tbl" id="table"></div></section>
 <section><div class="notes">${notes(r).map(x => `<p>${svg("info", 16)}<span>${h(x)}</span></p>`).join("")}</div></section>
 <footer>Sending runs Monday to Friday, 08:00–17:30 UK time.</footer>
</main>
<script>
const D=${json};
const $=s=>document.querySelector(s), fmt=x=>Number(x||0).toLocaleString("en-GB");
const KEYS=["sent","replies","clicks","enquiries","bounced","unsubscribes"];
const st={r:"7",b:"all",m:"sent",from:"",to:""};
try{const q=new URLSearchParams(location.search);if(q.get("range"))st.r=q.get("range");if(q.get("brand"))st.b=q.get("brand");if(q.get("from"))st.from=q.get("from");if(q.get("to"))st.to=q.get("to");}catch(e){}
const add=(k,n)=>{const d=new Date(k+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const nice=(k,o)=>new Date(k+"T12:00:00Z").toLocaleDateString("en-GB",Object.assign({timeZone:"UTC"},o||{weekday:"short",day:"numeric",month:"short"}));
const first=D.days[0].day;
function range(){
  if(st.r==="today")return[D.today,D.today];
  if(st.r==="yesterday")return[D.yesterday,D.yesterday];
  if(st.r==="month")return[D.today.slice(0,8)+"01",D.today];
  if(st.r==="custom"){let f=st.from||add(D.today,-6),t=st.to||D.today;if(f<first)f=first;if(t>D.today)t=D.today;if(f>t)[f,t]=[t,f];return[f,t]}
  return[add(D.today,-(Number(st.r)||7)+1),D.today];
}
const brands=()=>st.b==="all"?D.brands.map(b=>b.key):[st.b];
const sum=(rows,keys)=>{const o=Object.fromEntries(KEYS.map(k=>[k,0]));rows.forEach(d=>keys.forEach(b=>KEYS.forEach(k=>o[k]+=(d.b[b]||{})[k]||0)));return o};
const pct=(a,b)=>b?(100*a/b).toFixed(1)+"%":"–";
function seg(id,key,attr){document.querySelectorAll("#"+id+" button").forEach(btn=>btn.setAttribute("aria-pressed",String(btn.dataset[attr]===st[key])))}
function render(){
  const[f,t]=range(), rows=D.days.filter(d=>d.day>=f&&d.day<=t), bk=brands(), s=sum(rows,bk);
  seg("range","r","r");seg("brand","b","b");seg("metric","m","m");
  $("#dates").classList.toggle("on",st.r==="custom");$("#dfrom").value=f;$("#dto").value=t;$("#dfrom").min=$("#dto").min=first;$("#dfrom").max=$("#dto").max=D.today;
  $("#ptitle").textContent=f===t?nice(f,{weekday:"long",day:"numeric",month:"long"}):nice(f,{day:"numeric",month:"short"})+" – "+nice(t,{day:"numeric",month:"short",year:"numeric"});
  $("#psub").textContent=(st.b==="all"?"All brands":D.brands.find(b=>b.key===st.b).name)+(t===D.today?" · today's figures are so far":"");
  const sub={sent:rows.length+" day"+(rows.length===1?"":"s"),replies:pct(s.replies,s.sent)+" reply rate",clicks:pct(s.clicks,s.sent)+" click rate",enquiries:(s.clicks?pct(s.enquiries,s.clicks)+" completion rate · ":"")+pct(s.enquiries,s.sent)+" of emails",bounced:pct(s.bounced,s.sent)+" bounce rate",unsubscribes:pct(s.unsubscribes,s.sent)+" of emails sent"};
  $("#kpis").innerHTML=KEYS.map((k,i)=>{const m=D.metrics[k];return '<div class="kpi" style="--c:'+m.color+';--t:'+m.tint+';animation-delay:'+(i*50)+'ms"><div class="ic">'+m.icon+'</div><div class="v num">'+fmt(s[k])+'</div><div class="l">'+m.name+'</div><div class="s">'+sub[k]+'</div></div>'}).join("");
  const all=sum(rows,D.brands.map(b=>b.key));
  $("#split").innerHTML=D.brands.filter(b=>bk.includes(b.key)).map(b=>{const x=sum(rows,[b.key]);const sh=all.sent?100*x.sent/all.sent:0;
    return '<div class="brand" style="--bc:'+b.color+'"><div class="top"><span class="nm">'+b.name+'</span><span class="big num">'+fmt(x.sent)+'</span></div><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)"><span>emails sent</span><span>'+sh.toFixed(0)+'% of volume</span></div><div class="share"><i style="width:'+sh+'%"></i></div><div class="rows">'+
    ["replies","clicks","enquiries","bounced"].map(k=>{const m=D.metrics[k];return '<div class="row" style="--c:'+m.color+'">'+m.icon.replace('width="20" height="20"','width="16" height="16"')+m.name+'<b>'+fmt(x[k])+'</b></div>'}).join("")+'</div></div>'}).join("");
  ramp();chart(rows,bk);table(rows,bk,s);
  try{const q=new URLSearchParams({range:st.r,brand:st.b});if(st.r==="custom"){q.set("from",f);q.set("to",t)}history.replaceState(null,"","?"+q)}catch(e){}
}
function chart(rows,bk){
  const el=$("#chart"),W=el.clientWidth||900,H=240,P={l:34,r:8,t:10,b:28},m=st.m,mc=D.metrics[m];
  const cols=rows.map(d=>({day:d.day,v:bk.map(b=>({b,v:(d.b[b]||{})[m]||0}))}));
  const max=Math.max(1,...cols.map(c=>c.v.reduce((a,x)=>a+x.v,0)));
  const step=Math.pow(10,Math.floor(Math.log10(max)));const top=Math.ceil(max/step)*step;
  const iw=W-P.l-P.r,ih=H-P.t-P.b,bw=iw/Math.max(1,cols.length),y=v=>P.t+ih-ih*v/top;
  let g="";for(let i=0;i<=4;i++){const v=top*i/4;g+='<line class="grid" x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text x="'+(P.l-6)+'" y="'+(y(v)+4)+'" text-anchor="end">'+fmt(Math.round(v))+'</text>'}
  const every=Math.ceil(cols.length/12);
  cols.forEach((c,i)=>{let acc=0;const x=P.l+i*bw+bw*.18,w=Math.max(2,bw*.64);let bars="";
    c.v.forEach(p=>{if(!p.v)return;const color=m==="sent"?D.brands.find(b=>b.key===p.b).color:mc.color;const op=m==="sent"?1:(p.b===bk[0]?1:.55);
      bars+='<rect class="bar" x="'+x+'" y="'+y(acc+p.v)+'" width="'+w+'" height="'+(y(acc)-y(acc+p.v))+'" rx="'+Math.min(4,w/3)+'" fill="'+color+'" fill-opacity="'+op+'"/>';acc+=p.v});
    const tip=nice(c.day)+": "+c.v.map(p=>D.brands.find(b=>b.key===p.b).name+" "+fmt(p.v)).join(", ");
    g+='<g class="col"><title>'+tip+'</title><rect x="'+(P.l+i*bw)+'" y="'+P.t+'" width="'+bw+'" height="'+ih+'" fill="transparent"/>'+bars+'</g>';
    if(i%every===0)g+='<text x="'+(x+w/2)+'" y="'+(H-8)+'" text-anchor="middle">'+nice(c.day,{day:"numeric",month:"short"})+'</text>'});
  if(!cols.some(c=>c.v.some(p=>p.v)))g+='<text class="empty" x="'+(W/2)+'" y="'+(H/2)+'" text-anchor="middle">No '+mc.name.toLowerCase()+' in this period yet</text>';
  el.setAttribute("viewBox","0 0 "+W+" "+H);el.innerHTML=g;
  $("#legend").innerHTML=m==="sent"?D.brands.filter(b=>bk.includes(b.key)).map(b=>'<span><span class="dot" style="background:'+b.color+'"></span>'+b.name+'</span>').join(""):'<span><span class="dot" style="background:'+mc.color+'"></span>'+mc.name+(bk.length>1?" (lighter shade: "+D.brands.find(b=>b.key===bk[1]).name+")":"")+'</span>';
}
function ramp(){
  const plan=D.ramp||[];if(!plan.length){$("#rampcard").style.display="none";return}
  const el=$("#ramp"),W=el.clientWidth||900,H=260,P={l:40,r:16,t:22,b:28};
  const goal=plan[plan.length-1],start=plan[0].day<first?first:plan[0].day,end=add(goal.day>D.today?goal.day:D.today,4);
  const keys=[];for(let k=start;k<=end;k=add(k,1))keys.push(k);
  const byDay=Object.fromEntries(D.days.map(d=>[d.day,d.b]));
  const planAt=k=>{let v=0;plan.forEach(p=>{if(p.day<=k)v=p.v});return v};
  const sentAt=k=>D.brands.reduce((a,b)=>a+(((byDay[k]||{})[b.key]||{}).sent||0),0);
  const max=Math.max(1,...keys.map(planAt),...keys.map(sentAt));
  const raw=max*1.08/5,mag=Math.pow(10,Math.floor(Math.log10(raw))),tick=[1,2,2.5,5,10].map(f=>f*mag).find(s=>s>=raw),top=tick*5;
  const iw=W-P.l-P.r,ih=H-P.t-P.b,bw=iw/keys.length,y=v=>P.t+ih-ih*v/top,xL=i=>P.l+i*bw;
  let g="";for(let i=0;i<=5;i++){const v=tick*i;g+='<line class="grid" x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text x="'+(P.l-6)+'" y="'+(y(v)+4)+'" text-anchor="end">'+fmt(Math.round(v))+'</text>'}
  const every=Math.ceil(keys.length/(W<560?5:10));
  keys.forEach((k,i)=>{let acc=0;const x=xL(i)+bw*.15,w=Math.max(1.5,bw*.7);let bars="";
    if(k<=D.today)D.brands.forEach(b=>{const v=(((byDay[k]||{})[b.key]||{}).sent)||0;if(!v)return;bars+='<rect class="bar" x="'+x+'" y="'+y(acc+v)+'" width="'+w+'" height="'+(y(acc)-y(acc+v))+'" rx="'+Math.min(3,w/3)+'" fill="'+b.color+'"/>';acc+=v});
    g+='<g class="col"><title>'+nice(k)+': '+(k<=D.today?fmt(sentAt(k))+' sent'+(k===D.today?' so far':'')+' · ':'')+'plan '+fmt(planAt(k))+'/day</title><rect x="'+xL(i)+'" y="'+P.t+'" width="'+bw+'" height="'+ih+'" fill="transparent"/>'+bars+'</g>';
    if(i%every===0)g+='<text x="'+(xL(i)+bw/2)+'" y="'+(H-8)+'" text-anchor="middle">'+nice(k,{day:"numeric",month:"short"})+'</text>'});
  const ti=keys.indexOf(D.today);
  const path=(from,to)=>{let d="";for(let i=from;i<=to;i++){const v=planAt(keys[i]);d+=(i===from?"M":"L")+xL(i)+","+y(v)+"L"+(xL(i)+bw)+","+y(v)}return d};
  if(ti>0)g+='<path class="plan done" d="'+path(0,ti)+'"/>';
  g+='<path class="plan" d="'+path(Math.max(0,ti),keys.length-1)+'"/>';
  if(ti>=0){const tx=xL(ti)+bw/2;g+='<line class="today" x1="'+tx+'" x2="'+tx+'" y1="'+(P.t-6)+'" y2="'+(P.t+ih)+'"/><text class="tl" x="'+tx+'" y="'+(P.t-10)+'" text-anchor="'+(ti>keys.length-4?"end":"middle")+'">Today</text>'}
  const gi=keys.indexOf(goal.day);if(gi>=0)g+='<text class="goal" x="'+Math.min(W-P.r,xL(gi))+'" y="'+(y(goal.v)-8)+'" text-anchor="'+(gi>keys.length*0.7?"end":"start")+'">'+fmt(goal.v)+' a day</text>';
  el.setAttribute("viewBox","0 0 "+W+" "+H);el.innerHTML=g;
  const now=planAt(D.today);
  $("#rampnow").innerHTML='Planned now <b>'+fmt(now)+'</b>/day · full volume <b>'+fmt(goal.v)+'</b>/day '+(goal.day>D.today?'from '+nice(goal.day,{day:"numeric",month:"long"}):'reached');
  $("#ramplegend").innerHTML=D.brands.map(b=>'<span><span class="dot" style="background:'+b.color+'"></span>'+b.name+' sent</span>').join("")+'<span><svg width="22" height="8" style="vertical-align:1px;margin-right:6px"><line x1="0" x2="22" y1="4" y2="4" stroke="#191714" stroke-width="2" stroke-dasharray="6 5"/></svg>Planned daily volume</span>';
}
function table(rows,bk,s){
  const ks=["sent","replies","clicks","enquiries","bounced","unsubscribes"];
  const chip=(k,v)=>v&&k!=="sent"?'<span class="chip" style="--c:'+D.metrics[k].color+';--t:'+D.metrics[k].tint+'">'+fmt(v)+'</span>':fmt(v);
  let hb='<tr><th>Day</th>'+ks.map(k=>'<th>'+D.metrics[k].name.replace("Emails ","")+'</th>').join("")+'</tr>';
  const body=rows.slice().reverse().map(d=>{const x=sum([d],bk);return '<tr class="'+(x.sent?"":"zero")+'"><td>'+nice(d.day)+(d.day===D.today?' <span style="color:var(--muted);font-size:12px">so far</span>':'')+'</td>'+ks.map(k=>'<td>'+chip(k,x[k])+'</td>').join("")+'</tr>'}).join("");
  $("#table").innerHTML='<table>'+hb+body+'<tr class="tot"><td>Total</td>'+ks.map(k=>'<td>'+fmt(s[k])+'</td>').join("")+'</tr></table>';
}
document.querySelectorAll("#range button").forEach(b=>b.onclick=()=>{st.r=b.dataset.r;render()});
document.querySelectorAll("#brand button").forEach(b=>b.onclick=()=>{st.b=b.dataset.b;render()});
document.querySelectorAll("#metric button").forEach(b=>b.onclick=()=>{st.m=b.dataset.m;render()});
$("#dfrom").onchange=e=>{st.from=e.target.value;st.r="custom";render()};$("#dto").onchange=e=>{st.to=e.target.value;st.r="custom";render()};
let rt;window.addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(render,150)});
if(!D.brands.some(b=>b.key===st.b))st.b="all";
render();
</script>
</body></html>`;
}

/** The morning email: the previous day's sending (email-safe HTML: tables, inline styles, no SVG). */
export async function renderEmail(dayKey = yesterdayKey()) {
  const d = await dailyReport(dayKey, dayKey);
  const day = d.days[0];
  const variantHtml = await variantSectionsHtml(dayKey);
  const link = reportCfg.token ? `${reportCfg.baseUrl}/report/${encodeURIComponent(reportCfg.token)}?range=yesterday` : "";
  const subject = `Campaign report · ${nice(dayKey, { weekday: "long", day: "numeric", month: "long" })}: ${n(day.total.sent)} sent, ${n(day.total.replies)} ${day.total.replies === 1 ? "reply" : "replies"}`;
  const serif = "Georgia,'Times New Roman',serif", sans = "Helvetica,Arial,sans-serif";
  const kpi = (k, sub) => `<td width="50%" valign="top" style="padding:5px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffdf9;border:1px solid #e7dfd2;border-left:3px solid ${METRIC[k].color};border-radius:10px"><tr><td style="padding:12px 14px">
<div style="font:600 11px ${sans};letter-spacing:.08em;text-transform:uppercase;color:${METRIC[k].color}">${METRIC[k].name}</div>
<div style="font:700 28px ${sans};letter-spacing:-.02em;color:#191714;margin-top:4px">${n(day.total[k])}</div>
<div style="font:12px ${sans};color:#857b6e;margin-top:2px">${sub}</div></td></tr></table></td>`;
  const brandRow = (b) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #f1ebe1;font:15px ${serif};color:#191714"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${BRAND_COLOR[b]};margin-right:8px"></span>${h(label(b))}</td>${
    ["sent", "replies", "clicks", "enquiries"].map(k => `<td align="right" style="padding:10px 6px;border-bottom:1px solid #f1ebe1;font:14px ${sans};color:${day.brands[b][k] && k !== "sent" ? METRIC[k].color : "#191714"};${day.brands[b][k] && k !== "sent" ? "font-weight:700;" : ""}">${n(day.brands[b][k])}</td>`).join("")}</tr>`;
  const th = (x) => `<th align="right" style="padding:8px 6px;font:600 10px ${sans};letter-spacing:.06em;text-transform:uppercase;color:#857b6e;border-bottom:1px solid #e7dfd2">${x}</th>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f7f3ec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f3ec"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
<tr><td style="background:#16130f;border-radius:14px 14px 0 0;padding:24px 22px;border-bottom:3px solid #c8892b">
<div style="font:600 11px ${sans};letter-spacing:.22em;text-transform:uppercase;color:#d9b77c">Email campaign report</div>
<div style="font:400 26px ${serif};color:#f3eadb;margin-top:6px">${h(nice(dayKey, { weekday: "long", day: "numeric", month: "long" }))}</div>
<div style="font:13px ${sans};color:#cfc3ae;margin-top:6px">${BRANDS.map(b => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${BRAND_COLOR[b]};margin-right:6px"></span>${h(label(b))}`).join(" &nbsp; ")}</div>
</td></tr>
<tr><td style="background:#f7f3ec;padding:14px 6px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr>${kpi("sent", "across all brands")}${kpi("replies", pct(day.total.replies, day.total.sent) + " reply rate")}</tr>
<tr>${kpi("clicks", pct(day.total.clicks, day.total.sent) + " click rate")}${kpi("enquiries", day.total.clicks ? pct(day.total.enquiries, day.total.clicks) + " completion rate" : "HubSpot website forms")}</tr>
<tr>${kpi("bounced", pct(day.total.bounced, day.total.sent) + " bounce rate")}${kpi("unsubscribes", "opted out")}</tr>
</table></td></tr>
<tr><td style="padding:10px 6px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffdf9;border:1px solid #e7dfd2;border-radius:10px">
<tr><th align="left" style="padding:8px 12px;font:600 10px ${sans};letter-spacing:.06em;text-transform:uppercase;color:#857b6e;border-bottom:1px solid #e7dfd2">By brand</th>${th("Sent")}${th("Replies")}${th("Clicks")}${th("Forms")}</tr>
${BRANDS.map(brandRow).join("")}</table></td></tr>
${variantHtml ? `<tr><td style="padding:10px 6px 0">${variantHtml}</td></tr>` : ""}
${link ? `<tr><td align="center" style="padding:22px 6px 6px"><a href="${h(link)}" style="display:inline-block;background:#c8892b;color:#16130f;font:600 14px ${sans};text-decoration:none;padding:12px 22px;border-radius:999px">Open the full report &rarr;</a></td></tr>` : ""}
<tr><td style="padding:16px 10px 4px;font:12px/1.5 ${sans};color:#857b6e">${h(notes(d)[0])}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Email campaign report: ${nice(dayKey, { weekday: "long", day: "numeric", month: "long" })}`, "",
    ...BRANDS.map(b => `${label(b)}: ${n(day.brands[b].sent)} sent, ${n(day.brands[b].replies)} replies, ${n(day.brands[b].clicks)} clicks, ${n(day.brands[b].enquiries)} form completions`),
    `Total: ${n(day.total.sent)} sent, ${n(day.total.replies)} replies, ${n(day.total.clicks)} clicks, ${n(day.total.enquiries)} form completions, ${n(day.total.bounced)} bounced`,
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
