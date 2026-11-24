/**
 * Hourly sending-health watch (Rob, 20 Nov 2026: "keep an eye on the email health status, and send me an email if
 * something is high priority"). Emails Rob ("HIGH PRIORITY") at most once per problem per day when:
 *   - an Instantly sending account is disconnected or in error (status != 1), or its warm-up health drops below 85
 *   - a mailer mailbox is failing to send (3+ failed sends in 2 hours, or a fresh SMTP error)
 *   - the mailer has stopped sending during the send window although emails are due
 *   - the autopilot run failed
 * Campaign stops and bounce rates are covered by bounce-watch.js (same alert route).
 */
import { all, getSetting, setSetting } from "./db.js";
import { cfg, inSendWindow, nowLocal } from "./config.js";
import { transportFor } from "./mailer.js";
import { escapeHtml as h } from "./templates.js";
import { autopilotState } from "./autopilot.js";
import { reportState } from "./report.js";

export const healthWatchState = { lastRun: null, lastResult: "" };
const API = "https://api.instantly.ai/api/v2";
const KEY = () => process.env.INSTANTLY_REPORT_API_KEY || "";
const ACCOUNT_STATUS = { 1: "active", 2: "paused", "-1": "connection error", "-2": "soft bounce error", "-3": "sending error" };
const MIN_HEALTH = () => Number(process.env.HEALTH_ALERT_MIN || 85);

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${KEY()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return r.json();
}

export async function sendAlert(subject, html, fromName = "Campaign Alert") {
  if (process.env.HEALTH_DRY) return console.log("[health-watch dry] would email:", subject, html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const to = (await getSetting("report_internal_to", "")).split(",").map(s => s.trim()).filter(Boolean);
  const mbEmail = await getSetting("report_email_mailbox", "");
  const mailbox = mbEmail && (await all("SELECT * FROM mailboxes WHERE lower(email)=lower($1)", [mbEmail]))[0];
  if (!to.length || !mailbox) return console.warn("[health-watch] alert not sent (no report_internal_to / report_email_mailbox):", subject);
  await transportFor(mailbox).sendMail({ from: { name: fromName, address: mailbox.email }, to, subject, html });
  console.log("[health-watch] alert sent:", subject);
}

async function onceToday(key) {
  if (process.env.HEALTH_DRY) return true;
  const today = nowLocal().dateKey;
  const m = JSON.parse(await getSetting("health_watch_alerts", "{}") || "{}");
  if (m[key] === today) return false;
  for (const k of Object.keys(m)) if (m[k] < today) delete m[k];
  m[key] = today; await setSetting("health_watch_alerts", JSON.stringify(m)); return true;
}

async function instantlyAccounts(problems, ok) {
  const accounts = []; let after;
  for (;;) { const j = await api("GET", `/accounts?limit=100${after ? `&starting_after=${after}` : ""}`); accounts.push(...(j.items || [])); if (!j.next_starting_after) break; after = j.next_starting_after; }
  // Accounts that matter: in an active campaign, or warming up to join one.
  const camps = (await api("GET", "/campaigns?limit=100")).items || [];
  const inUse = new Map();
  for (const c of camps.filter(c => Number(c.status) === 1)) for (const e of c.email_list || []) inUse.set(String(e).toLowerCase(), c.name);
  const watched = accounts.filter(a => inUse.has(a.email.toLowerCase()) || Number(a.warmup_status) === 1);
  const health = watched.length ? (await api("POST", "/accounts/warmup-analytics", { emails: watched.map(a => a.email) })).aggregate_data || {} : {};
  for (const a of watched) {
    const where = inUse.get(a.email.toLowerCase()) ? `sending in "${inUse.get(a.email.toLowerCase())}"` : "warming up";
    if (Number(a.status) !== 1) problems.push({ key: `acct:${a.email}:status${a.status}`, text: `Instantly account <b>${h(a.email)}</b> (${where}) is <b>${h(ACCOUNT_STATUS[a.status] || `status ${a.status}`)}</b>. Reconnect it in Instantly → Email Accounts.` });
    const w = health[a.email] || {};
    if (Number(w.sent || 0) >= 10 && Number(w.health_score) < MIN_HEALTH())
      problems.push({ key: `acct:${a.email}:health`, text: `Instantly account <b>${h(a.email)}</b> (${where}) warm-up health is <b>${w.health_score}</b> (inbox ${w.landed_inbox || 0}, spam ${w.landed_spam || 0} of ${w.sent}). Its emails are starting to land in spam.` });
  }
  ok.push(`Instantly: ${watched.length} accounts watched`);
}

async function mailerMailboxes(problems, ok) {
  const failing = await all(`SELECT m.email, count(s.id)::int fails, max(s.error) err FROM mailboxes m JOIN sends s ON s.mailbox_id=m.id
    WHERE m.enabled AND s.status='failed' AND s.sent_at > now() - interval '2 hours' GROUP BY m.email HAVING count(s.id) >= 3`);
  for (const f of failing) problems.push({ key: `mbx:${f.email}:fail`, text: `Mailer mailbox <b>${h(f.email)}</b> failed ${f.fails} sends in the last 2 hours: ${h(String(f.err || "").slice(0, 200))}` });
  const errs = await all(`SELECT email, last_error FROM mailboxes WHERE enabled AND last_error_at > now() - interval '70 minutes'`);
  // Reply-inbox (IMAP) errors are often one-off provider hiccups: alert only after 3 hourly checks in a row see one.
  // Sending errors alert straight away.
  const streak = JSON.parse(await getSetting("health_imap_streak", "{}") || "{}"), nextStreak = {};
  for (const e of errs) {
    if (failing.find(f => f.email === e.email)) continue;
    const imap = /^IMAP:/i.test(String(e.last_error || ""));
    if (imap) { nextStreak[e.email] = (streak[e.email] || 0) + 1; if (nextStreak[e.email] < 3) continue; }
    problems.push({ key: `mbx:${e.email}:err`, text: `Mailer mailbox <b>${h(e.email)}</b> ${imap ? `has failed its reply-inbox check for ${nextStreak[e.email]} hours in a row` : "reported a sending error"}: ${h(String(e.last_error || "").slice(0, 200))}` });
  }
  if (!process.env.HEALTH_DRY) await setSetting("health_imap_streak", JSON.stringify(nextStreak));
  // Stalled: nothing sent for 90 minutes inside the window, emails due, AND today is well behind the usual pace
  // for this time of day (so a mailer that has simply hit today's caps is not flagged).
  const now = new Date(), earlier = new Date(now - 90 * 60_000);
  if (inSendWindow(now) && inSendWindow(earlier)) {
    const [{ sent }] = await all(`SELECT count(*)::int sent FROM sends WHERE status<>'failed' AND sent_at > now() - interval '90 minutes'`);
    const [{ due }] = await all(`SELECT count(*)::int due FROM enrolments e JOIN campaigns c ON c.id=e.campaign_id AND c.status='active'
      JOIN contacts ct ON ct.id=e.contact_id AND ct.status='active' WHERE e.status='active' AND e.next_due_at <= now()`);
    const pace = await all(`SELECT (sent_at AT TIME ZONE $1)::date d, count(*)::int n FROM sends
      WHERE status<>'failed' AND sent_at > now() - interval '9 days' AND (sent_at AT TIME ZONE $1)::time <= (now() AT TIME ZONE $1)::time
      GROUP BY 1 ORDER BY 1`, [cfg.tz]);
    const today = nowLocal().dateKey, toDate = r => new Date(r.d).toISOString().slice(0, 10);
    const todayN = pace.find(r => toDate(r) === today)?.n || 0;
    const past = pace.filter(r => toDate(r) !== today && r.n > 0).map(r => r.n).sort((a, b) => a - b);
    const usual = past.length ? past[Math.floor(past.length / 2)] : 0;
    if (!sent && due > 0 && usual >= 20 && todayN < usual / 2)
      problems.push({ key: "mailer:stalled", text: `The mailer has sent <b>nothing in the last 90 minutes</b> and only ${todayN} today (usually ${usual} by now), with ${due} emails due. Check /healthz and the Render logs.` });
  }
  ok.push(`mailer: ${failing.length} failing mailbox(es)`);
}

// One-off reminders for Rob (setting "reminders": JSON [{at: ISO time, subject, html}]). Each is emailed on the first
// hourly check after its time, then removed.
async function dueReminders(ok) {
  const list = JSON.parse(await getSetting("reminders", "[]") || "[]");
  const due = list.filter(r => new Date(r.at) <= new Date());
  if (!due.length) return ok.push(`reminders: ${list.length} waiting`);
  for (const r of due) await sendAlert(r.subject, r.html, "Reminder");
  if (!process.env.HEALTH_DRY) await setSetting("reminders", JSON.stringify(list.filter(r => !due.includes(r))));
  ok.push(`reminders: sent ${due.length}`);
}

export async function checkHealth() {
  healthWatchState.lastRun = new Date();
  const problems = [], ok = [];
  if (KEY()) await instantlyAccounts(problems, ok).catch(e => ok.push(`Instantly check error: ${e.message}`));
  await mailerMailboxes(problems, ok).catch(e => ok.push(`mailer check error: ${e.message}`));
  await dueReminders(ok).catch(e => ok.push(`reminder error: ${e.message}`));
  const weekly = (reportState.lastResult || "").match(/weekly sheet: error[^;]*/);
  if (weekly) problems.push({ key: "report:weekly", text: `Mike's weekly opens &amp; clicks spreadsheet failed: ${h(weekly[0].slice(0, 300))}` });
  if (/error/i.test(autopilotState.lastResult || "")) problems.push({ key: "autopilot:error", text: `The campaign autopilot reported an error: ${h(autopilotState.lastResult.slice(0, 300))}` });
  const fresh = [];
  for (const p of problems) if (await onceToday(p.key)) fresh.push(p);
  if (fresh.length) await sendAlert(`HIGH PRIORITY: ${fresh.length} sending problem${fresh.length > 1 ? "s" : ""} need attention`,
    `<ul>${fresh.map(p => `<li style="margin-bottom:8px">${p.text}</li>`).join("")}</ul><p style="color:#666">From the hourly health check on ukv-mailer. Each problem is emailed at most once a day.</p>`);
  healthWatchState.lastResult = `${new Date().toISOString().slice(0, 16)}: ${problems.length ? `${problems.length} problem(s): ${problems.map(p => p.key).join(", ")}` : "all healthy"} (${ok.join("; ")})`;
}

export function startHealthWatch() {
  const run = () => checkHealth().catch(e => { healthWatchState.lastResult = `error: ${e.message}`; console.warn("[health-watch]", e.message); });
  setTimeout(run, 6 * 60_000);
  setInterval(run, 60 * 60_000);
}
