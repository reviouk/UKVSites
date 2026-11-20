/**
 * Hourly watchdog for the Instantly campaigns (INSTANTLY_REPORT_CAMPAIGNS). Instantly pauses a campaign
 * on its own once bounces get high (16 Nov 2026: "paused due to high bounce rate"); this warns Rob first.
 *   - keeps hourly snapshots of each campaign's sent/bounced totals (setting bounce_watch_snapshots)
 *   - alerts when the last-24h bounce rate passes BOUNCE_ALERT_PCT (default 2%, needs >= 50 sends)
 *   - alerts when a campaign that was active is no longer active (paused by Instantly or by hand)
 * Alerts go to setting report_internal_to through the report mailbox, at most once per campaign per
 * reason per day. bounceWatchState feeds /healthz and Rob's daily report.
 */
import { all, getSetting, setSetting } from "./db.js";
import { transportFor } from "./mailer.js";
import { escapeHtml as h } from "./templates.js";

export const bounceWatchState = { lastRun: null, lastResult: "", campaigns: {} };
const ALERT_PCT = () => Number(process.env.BOUNCE_ALERT_PCT || 2);
const KEY = () => process.env.INSTANTLY_REPORT_API_KEY || "";
const CAMPAIGNS = () => String(process.env.INSTANTLY_REPORT_CAMPAIGNS || "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher")
  .split(",").map(s => s.trim()).filter(Boolean).map(s => s.split(":")[0]);
const STATUS = { 0: "draft", 1: "active", 2: "paused", 3: "completed", "-1": "paused (unhealthy accounts)", "-2": "paused (bounce protection)", "-99": "suspended" };

async function alert(subject, html) {
  const to = (await getSetting("report_internal_to", "")).split(",").map(s => s.trim()).filter(Boolean);
  const mbEmail = await getSetting("report_email_mailbox", "");
  const mailbox = mbEmail && (await all("SELECT * FROM mailboxes WHERE lower(email)=lower($1)", [mbEmail]))[0];
  if (!to.length || !mailbox) { console.warn("[bounce-watch] alert not sent (no report_internal_to / report_email_mailbox):", subject); return; }
  await transportFor(mailbox).sendMail({ from: { name: "Campaign Alert", address: mailbox.email }, to, subject, html });
  console.log("[bounce-watch] alert sent:", subject);
}

async function onceToday(key) {
  const today = new Date().toISOString().slice(0, 10);
  const sent = JSON.parse(await getSetting("bounce_watch_alerts", "{}") || "{}");
  if (sent[key] === today) return false;
  sent[key] = today;
  await setSetting("bounce_watch_alerts", JSON.stringify(sent));
  return true;
}

export async function checkBounces() {
  if (!KEY()) { bounceWatchState.lastResult = "no INSTANTLY_REPORT_API_KEY"; return; }
  bounceWatchState.lastRun = new Date();
  const snaps = JSON.parse(await getSetting("bounce_watch_snapshots", "{}") || "{}");
  const now = Date.now(), out = [];
  for (const id of CAMPAIGNS()) {
    const r = await fetch(`https://api.instantly.ai/api/v2/campaigns/analytics?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${KEY()}` } });
    if (!r.ok) { out.push(`${id.slice(0, 8)}: analytics ${r.status}`); continue; }
    const j = await r.json(); const a = Array.isArray(j) ? j[0] : j;
    if (!a) continue;
    const cur = { at: now, sent: Number(a.emails_sent_count || 0), bounced: Number(a.bounced_count || 0), status: Number(a.campaign_status) };
    const list = (snaps[id] || []).filter(s => now - s.at < 49 * 3600e3);
    const base = [...list].reverse().find(s => now - s.at >= 23 * 3600e3) || list[0] || cur;   // newest snapshot at least ~24h old
    const sent24 = cur.sent - base.sent, bounced24 = cur.bounced - base.bounced;
    const rate24 = sent24 > 0 ? (100 * bounced24) / sent24 : 0;
    const prevStatus = list.length ? list[list.length - 1].status : cur.status;
    list.push(cur); snaps[id] = list;
    const name = a.campaign_name || id;
    bounceWatchState.campaigns[id] = { name, status: STATUS[cur.status] || String(cur.status), sent24, bounced24, rate24: Number(rate24.toFixed(2)),
      total: cur.sent ? Number(((100 * cur.bounced) / cur.sent).toFixed(2)) : 0 };
    out.push(`${name}: ${STATUS[cur.status] || cur.status}, 24h ${bounced24}/${sent24} bounced (${rate24.toFixed(1)}%)`);

    if (prevStatus === 1 && cur.status !== 1 && await onceToday(`${id}:paused`)) {
      await alert(`⚠ Instantly campaign stopped: ${name}`, `<p>The Instantly campaign <b>${h(name)}</b> is now <b>${h(STATUS[cur.status] || String(cur.status))}</b> (it was active an hour ago).</p>
<p>Bounces in the last 24h: ${bounced24} of ${sent24} sent (${rate24.toFixed(1)}%). All time: ${cur.bounced} of ${cur.sent} (${bounceWatchState.campaigns[id].total}%).</p>`);
    }
    if (sent24 >= 50 && rate24 >= ALERT_PCT() && await onceToday(`${id}:rate`)) {
      await alert(`⚠ Bounce rate ${rate24.toFixed(1)}% on ${name}`, `<p><b>${h(name)}</b> bounced <b>${bounced24} of ${sent24}</b> emails in the last 24 hours (<b>${rate24.toFixed(1)}%</b>, alert level ${ALERT_PCT()}%).</p>
<p>Instantly pauses a campaign by itself if this keeps climbing. Check which email domains are bouncing and hold them before it does.</p>`);
    }
    // Instantly paused at ~5% all-time on 16 Nov (46/919); warn well before that.
    const total = bounceWatchState.campaigns[id].total;
    if (cur.status === 1 && cur.sent >= 200 && total >= 4 && await onceToday(`${id}:total`)) {
      await alert(`⚠ ${name}: all-time bounce rate ${total}%`, `<p><b>${h(name)}</b> has bounced <b>${cur.bounced} of ${cur.sent}</b> emails overall (<b>${total}%</b>). Instantly paused this campaign at about 5% on 16 Nov.</p>`);
    }
  }
  await setSetting("bounce_watch_snapshots", JSON.stringify(snaps));
  bounceWatchState.lastResult = `${new Date().toISOString().slice(0, 16)}: ${out.join("; ")}`;
}

export function startBounceWatch() {
  const run = () => checkBounces().catch(e => { bounceWatchState.lastResult = `error: ${e.message}`; console.warn("[bounce-watch]", e.message); });
  setTimeout(run, 3 * 60_000);
  setInterval(run, 60 * 60_000);
}
