/**
 * Campaign autopilot for the Instantly campaigns (Rob, 20 Nov 2026: "these campaigns need to be self managed,
 * with regular checks 4 times a day"). Runs at AUTOPILOT_TIMES (default 07:00, 11:00, 15:00, 19:00 London).
 * Each run, per campaign in setting autopilot_campaigns:
 *   1. Bounce guard: bounced addresses are marked bounced in the mailer (never emailed again). Any domain that
 *      bounces is held: if it has < 20 contacted leads, one bounce holds it; with >= 20, a rate >= 5% does.
 *      Unsent leads of held domains move to the hold campaign (never activated) and are marked held here.
 *   2. Bounce protection: if Instantly paused the campaign for bounces (status -2), it is re-activated once a day
 *      after the guard has cleaned it. Campaigns paused by hand (status 2) are never touched.
 *   3. Top-up: an active campaign with under TOPUP_MIN_DAYS of unsent leads gets fresh verified-OK leads
 *      (non-Microsoft for the Google pool, Microsoft for the M365 pool), never AOL/Yahoo/Virgin/BT/bigfoot/.ru,
 *      never a held domain, never an old-Instantly-list contact, never anyone the mailer has enrolled.
 *   4. Runway: when a campaign has under RUNWAY_ALERT_DAYS left and no fresh leads remain, Rob is told once a week.
 *   6. Warming accounts in setting autopilot_pending_accounts join their campaign once due and healthy.
 *   5. Mailer: the Invest Chronicle queue is kept at 10-14 days of first emails from the same verified pool.
 * Every action is logged to autopilotState (healthz + Rob's internal daily report) and emailed to Rob when it
 * changes something.
 */
import { all, q, getSetting, setSetting } from "./db.js";
import { nowLocal } from "./config.js";
import { transportFor } from "./mailer.js";
import { escapeHtml as h } from "./templates.js";

let DRY = false;
const write = (fn) => DRY ? Promise.resolve({ rowCount: 0, leads_uploaded: 0 }) : fn();
export const autopilotState = { lastRun: null, lastResult: "", log: [], campaigns: {} };
const API = "https://api.instantly.ai/api/v2";
const KEY = () => process.env.INSTANTLY_REPORT_API_KEY || "";
const TIMES = () => String(process.env.AUTOPILOT_TIMES || "07:00,11:00,15:00,19:00").split(",").map(s => s.trim()).filter(Boolean);
const HOLD_CAMPAIGN = () => process.env.INSTANTLY_HOLD_CAMPAIGN || "d3689581-7e7e-46da-b7f9-a5e6e3074d63";
const TOPUP_MIN_DAYS = 5, TOPUP_TARGET_DAYS = 8, RUNWAY_ALERT_DAYS = 10;
const DEFAULT_CAMPAIGNS = [
  { id: "2cecb091-fd83-4b06-a647-a9fa1ee64637", pool: "google" },      // Market Watcher - pre-warmed (Google DFY boxes)
  { id: "a6753784-0f6b-4ca6-becc-b65649d2f86a", pool: "microsoft" },   // Market Watcher - Dubai (M365 boxes)
];
// Providers whose servers pass verification then bounce (17 + 20 Nov 2026). Never uploaded.
export const RISKY_DOMAIN_SQL = String.raw`split_part(lower(email),'@',2) ~ '^(aol\.|yahoo\.|ymail\.|rocketmail\.|virgin\.net$|bigfoot\.com$|btinternet\.com$|btopenworld\.com$|talk21\.com$)|\.ru$'`;

async function api(method, path, body) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${KEY()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429 && tries < 10) { await new Promise(s => setTimeout(s, 5000)); continue; }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${String(t).slice(0, 200)}`);
    return j;
  }
}

async function listLeads(campaign) {
  const out = []; let after;
  for (;;) {
    const p = await api("POST", "/leads/list", { campaign, limit: 100, ...(after ? { starting_after: after } : {}) });
    out.push(...(p.items || []));
    if (!p.next_starting_after || !(p.items || []).length) break;
    after = p.next_starting_after;
  }
  return out;
}

async function waitJob(job) {
  for (let t = 0; t < 60 && job?.id; t++) {
    await new Promise(s => setTimeout(s, 4000));
    const st = await api("GET", `/background-jobs/${job.id}`).catch(() => ({}));
    if (/success|completed|failed|error/i.test(st.status || "")) return st.status;
  }
  return "unknown";
}

async function tellRob(subject, html) {
  if (DRY) return console.log("[autopilot dry] would email:", subject);
  const to = (await getSetting("report_internal_to", "")).split(",").map(s => s.trim()).filter(Boolean);
  const mbEmail = await getSetting("report_email_mailbox", "");
  const mailbox = mbEmail && (await all("SELECT * FROM mailboxes WHERE lower(email)=lower($1)", [mbEmail]))[0];
  if (!to.length || !mailbox) return console.warn("[autopilot] not emailed (no report_internal_to / report_email_mailbox):", subject);
  await transportFor(mailbox).sendMail({ from: { name: "Campaign Autopilot", address: mailbox.email }, to, subject, html });
}

const domainOf = e => String(e).split("@")[1]?.toLowerCase() || "";
const contacted = l => !!(l.timestamp_last_contact || l.status === 3 || l.status === -1);

async function manageCampaign(c, actions, notes, accounts) {
  const camp = await api("GET", `/campaigns/${c.id}`);
  const name = camp.name || c.id;
  const leads = await listLeads(c.id);

  // 1. Bounced addresses: never email again from the mailer either.
  const bounced = leads.filter(l => l.status === -1).map(l => l.email.toLowerCase());
  if (bounced.length) {
    const r = await write(() => q(`UPDATE contacts SET status='bounced', updated_at=now() WHERE lower(email)=ANY($1) AND status NOT IN ('bounced','unsubscribed')`, [bounced]));
    if (DRY) actions.push(`${name}: [dry] ${bounced.length} bounced in Instantly`);
    if (r.rowCount) actions.push(`${name}: ${r.rowCount} bounced address(es) marked bounced in the mailer`);
  }

  // Bounce guard by domain.
  const stats = {};
  for (const l of leads) {
    const d = domainOf(l.email); const s = stats[d] ??= { contacted: 0, bounced: 0, unsent: [] };
    if (contacted(l)) { s.contacted++; if (l.status === -1) s.bounced++; }
    else if (l.status === 1) s.unsent.push(l);
  }
  const badDomains = Object.entries(stats).filter(([, s]) => s.bounced > 0 && (s.contacted < 20 || s.bounced / s.contacted >= 0.05));
  const toMove = badDomains.flatMap(([, s]) => s.unsent);
  if (toMove.length) {
    for (let i = 0; i < toMove.length; i += 500) {
      const job = await write(() => api("POST", "/leads/move", { ids: toMove.slice(i, i + 500).map(l => l.id), campaign: c.id, to_campaign_id: HOLD_CAMPAIGN() }));
      await waitJob(job);
    }
    const emails = toMove.map(l => l.email.toLowerCase());
    await write(() => q(`UPDATE contacts SET status=CASE WHEN status='active' THEN 'held' ELSE status END, instantly_status=$2, updated_at=now() WHERE lower(email)=ANY($1)`,
      [emails, `held: autopilot, bouncing domain (${nowLocal().dateKey})`]));
    const doms = badDomains.filter(([, s]) => s.unsent.length).map(([d, s]) => `${d} (${s.bounced}/${s.contacted} bounced)`);
    actions.push(`${name}: held ${toMove.length} unsent lead(s) from bouncing domains: ${doms.slice(0, 15).join(", ")}${doms.length > 15 ? ` +${doms.length - 15} more` : ""}`);
  }
  // Remember held domains so top-ups never bring them back.
  const held = new Set(JSON.parse(await getSetting("autopilot_held_domains", "[]") || "[]"));
  const before = held.size; badDomains.forEach(([d]) => held.add(d));
  if (held.size !== before && !DRY) await setSetting("autopilot_held_domains", JSON.stringify([...held]));

  // 2. Instantly bounce protection: re-activate once a day once cleaned.
  let status = Number(camp.status);
  if (status === -2 && await onceToday(`reactivate:${c.id}`)) {
    await write(() => api("POST", `/campaigns/${c.id}/activate`, {}));
    status = 1;
    actions.push(`${name}: Instantly had paused it for bounces; bouncing domains held and campaign re-activated`);
  }

  // 3. Top-up.
  const unsent = leads.filter(l => l.status === 1 && !contacted(l)).length - toMove.length;
  // Real daily capacity: the campaign limit, capped by what its sending accounts can do.
  const accLimit = (camp.email_list || []).reduce((t, e) => t + Number(accounts[String(e).toLowerCase()]?.daily_limit || 0), 0);
  const limits = [Number(camp.daily_limit) || 0, accLimit].filter(x => x > 0);
  const daily = limits.length ? Math.min(...limits) : 1;
  const days = unsent / daily;
  let added = 0;
  if (status === 1 && days < TOPUP_MIN_DAYS) {
    const want = Math.max(0, Math.round(TOPUP_TARGET_DAYS * daily - unsent));
    const rows = await pickFresh(c.pool, want, [...held]);
    if (rows.length) {
      for (let i = 0; i < rows.length; i += 500) {
        const b = rows.slice(i, i + 500);
        const j = await write(() => api("POST", "/leads/add", { campaign_id: c.id, skip_if_in_workspace: true, leads: b.map(r => ({ email: r.email, first_name: r.first_name || "", last_name: r.last_name || "" })) }));
        added += Number(j.leads_uploaded || 0);
        await write(() => q(`UPDATE contacts SET instantly_contacted=true, instantly_sent_at=now(), instantly_status=$2, updated_at=now() WHERE id=ANY($1)`,
          [b.map(r => r.id), `uploaded: autopilot top-up ${name} (${nowLocal().dateKey})`]));
        if (DRY) added += b.length;
      }
      actions.push(`${name}: topped up with ${added} verified lead(s) (had ${unsent}, ${days.toFixed(1)} days)`);
    }
  }
  const fresh = (await pickFresh(c.pool, 100000, [...held])).length;
  const left = unsent + added, daysLeft = left / daily;
  notes.push(`${name}: ${Number(camp.status) === 2 ? "paused by hand" : status === 1 ? "active" : `status ${status}`}, ${left} unsent (~${daysLeft.toFixed(1)} days at ${daily}/day), ${fresh} fresh verified leads left for it`);
  autopilotState.campaigns = { ...(autopilotState.campaigns || {}), [c.id]: { name, status, left, daysLeft: Number(daysLeft.toFixed(1)), daily, fresh } };

  // 4. Runway warning (weekly).
  if (status === 1 && daysLeft < RUNWAY_ALERT_DAYS && fresh < daily && await onceThisWeek(`runway:${c.id}`)) {
    await tellRob(`Leads running low: ${name}`, `<p><b>${h(name)}</b> has about <b>${daysLeft.toFixed(1)} days</b> of leads left (${left} unsent at ${daily}/day) and no fresh verified leads remain for it.</p><p>New data is needed: import it, verify it, and the autopilot will load it.</p>`);
    actions.push(`${name}: runway warning sent (${daysLeft.toFixed(1)} days left)`);
  }
}

// 6. Warming accounts waiting to join a campaign (setting autopilot_pending_accounts: [{email, campaign, after}]).
//    Added once the date has passed, the account is connected (status 1) and its warm-up health is >= 95.
async function joinWarmedAccounts(actions, notes, accounts) {
  const pending = JSON.parse(await getSetting("autopilot_pending_accounts", "[]") || "[]");
  if (!pending.length) return;
  const due = pending.filter(p => nowLocal().dateKey >= p.after);
  const health = due.length ? (await api("POST", "/accounts/warmup-analytics", { emails: due.map(p => p.email) })).aggregate_data || {} : {};
  const keep = [];
  for (const p of pending) {
    const a = accounts[p.email.toLowerCase()], hs = Number(health[p.email]?.health_score || 0);
    if (nowLocal().dateKey < p.after || !a || Number(a.status) !== 1 || hs < 95) {
      keep.push(p);
      if (nowLocal().dateKey >= p.after) notes.push(`${p.email}: waiting to join (status ${a?.status ?? "missing"}, health ${hs})`);
      continue;
    }
    const camp = await api("GET", `/campaigns/${p.campaign}`);
    const list = [...new Set([...(camp.email_list || []), p.email])];
    await write(() => api("PATCH", `/campaigns/${p.campaign}`, { email_list: list }));
    actions.push(`${p.email} (warm-up health ${hs}) added to ${camp.name}`);
  }
  if (!DRY && keep.length !== pending.length) await setSetting("autopilot_pending_accounts", JSON.stringify(keep));
}

// 5. Mailer top-up: keep the Invest Chronicle queue (campaign MAILER_CAMPAIGN) at >= MAILER_MIN_DAYS of first emails.
const MAILER_CAMPAIGN = () => Number(process.env.AUTOPILOT_MAILER_CAMPAIGN || 2), MAILER_MIN_DAYS = 10, MAILER_TARGET_DAYS = 14;
async function manageMailer(actions, notes, heldDomains) {
  const c = (await all("SELECT id, name, status FROM campaigns WHERE id=$1", [MAILER_CAMPAIGN()]))[0];
  if (!c) return;
  const queued = Number((await all(`SELECT count(*)::int n FROM enrolments e JOIN contacts ct ON ct.id=e.contact_id
    WHERE e.campaign_id=$1 AND e.status='active' AND e.current_step=0 AND ct.status='active'`, [c.id]))[0].n);
  const perDay = Math.max(30, Number((await all(`SELECT round(count(*)/5.0)::int n FROM sends WHERE campaign_id=$1 AND step_position=1
    AND status<>'failed' AND sent_at > now() - interval '5 days'`, [c.id]))[0].n));
  let days = queued / perDay, added = 0;
  if (c.status === "active" && days < MAILER_MIN_DAYS) {
    const want = Math.round(MAILER_TARGET_DAYS * perDay - queued);
    const rows = await pickFresh("google", want, heldDomains);
    if (rows.length) {
      const r = await write(() => q(`INSERT INTO enrolments(campaign_id, contact_id, next_due_at) SELECT $1, unnest($2::int[]), now() ON CONFLICT DO NOTHING`, [c.id, rows.map(x => x.id)]));
      added = DRY ? rows.length : r.rowCount;
      actions.push(`${c.name}: enrolled ${added} verified contact(s) (queue was ${queued}, ${days.toFixed(1)} days)`);
    }
  }
  days = (queued + added) / perDay;
  notes.push(`${c.name}: ${queued + added} waiting for a first email (~${days.toFixed(1)} days at ${perDay}/day)`);
  autopilotState.campaigns = { ...(autopilotState.campaigns || {}), [`mailer-${c.id}`]: { name: c.name, left: queued + added, daysLeft: Number(days.toFixed(1)), daily: perDay } };
}

async function pickFresh(pool, limit, heldDomains) {
  if (limit <= 0) return [];
  return all(`SELECT id, email, first_name, last_name FROM contacts
    WHERE status='active' AND verify_result='ok' AND NOT instantly_contacted AND instantly_sent_at IS NULL
      AND ${pool === "microsoft" ? "mail_provider='microsoft'" : "coalesce(mail_provider,'other') NOT IN ('microsoft','none')"}
      AND coalesce(data_source,'') NOT ILIKE '%whisky%'   -- 6 Nov: Whisky sheets look like existing UKV leads, kept out
      AND NOT (${RISKY_DOMAIN_SQL}) AND NOT (split_part(lower(email),'@',2) = ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM enrolments e WHERE e.contact_id=contacts.id)
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=contacts.email)
    ORDER BY id LIMIT $1`, [limit, heldDomains]);
}

async function onceToday(key) {
  if (DRY) return true;
  const today = nowLocal().dateKey;
  const m = JSON.parse(await getSetting("autopilot_once", "{}") || "{}");
  if (m[key] === today) return false;
  m[key] = today; await setSetting("autopilot_once", JSON.stringify(m)); return true;
}
async function onceThisWeek(key) {
  if (DRY) return true;
  const d = new Date(); const wk = `${d.getUTCFullYear()}-w${Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 864e5 + 1) / 7)}`;
  const m = JSON.parse(await getSetting("autopilot_once", "{}") || "{}");
  if (m[key] === wk) return false;
  m[key] = wk; await setSetting("autopilot_once", JSON.stringify(m)); return true;
}

export async function runAutopilot({ dry = false } = {}) {
  DRY = dry;
  if (!KEY()) { autopilotState.lastResult = "no INSTANTLY_REPORT_API_KEY"; return; }
  autopilotState.lastRun = new Date();
  const campaigns = JSON.parse(await getSetting("autopilot_campaigns", "") || "null") || DEFAULT_CAMPAIGNS;
  const actions = [], notes = [];
  const accounts = {};
  try { let after; for (;;) { const j = await api("GET", `/accounts?limit=100${after ? `&starting_after=${after}` : ""}`); for (const a of j.items || []) accounts[a.email.toLowerCase()] = a; if (!j.next_starting_after) break; after = j.next_starting_after; } }
  catch (e) { console.warn("[autopilot] accounts", e.message); }
  for (const c of campaigns) {
    try { await manageCampaign(c, actions, notes, accounts); }
    catch (e) { notes.push(`${c.id.slice(0, 8)}: error ${e.message}`); console.warn("[autopilot]", c.id, e.message); }
  }
  try { await joinWarmedAccounts(actions, notes, accounts); }
  catch (e) { notes.push(`join accounts: error ${e.message}`); console.warn("[autopilot] join", e.message); }
  try { await manageMailer(actions, notes, JSON.parse(await getSetting("autopilot_held_domains", "[]") || "[]")); }
  catch (e) { notes.push(`mailer: error ${e.message}`); console.warn("[autopilot] mailer", e.message); }
  const stamp = new Date().toISOString().slice(0, 16);
  autopilotState.lastResult = `${stamp}: ${actions.length ? actions.join("; ") : "no action needed"} | ${notes.join("; ")}`;
  autopilotState.log = [...actions.map(a => `${stamp} ${a}`), ...autopilotState.log].slice(0, 50);
  if (DRY) { console.log("[autopilot dry]", autopilotState.lastResult); return autopilotState; }
  const log = JSON.parse(await getSetting("autopilot_log", "[]") || "[]");
  await setSetting("autopilot_log", JSON.stringify([...actions.map(a => ({ at: stamp, a })), ...log].slice(0, 200)));
  await setSetting("autopilot_status", JSON.stringify({ at: stamp, notes }));
  if (actions.length) await tellRob(`Autopilot: ${actions.length} change(s) to the campaigns`,
    `<ul>${actions.map(a => `<li>${h(a)}</li>`).join("")}</ul><p style="color:#666">Status: ${notes.map(h).join("<br>")}</p>`).catch(e => console.warn("[autopilot] email", e.message));
  console.log("[autopilot]", autopilotState.lastResult);
}

/** Every 5 min: run once per slot in AUTOPILOT_TIMES (London time); the slot is stored so restarts don't repeat it. */
export function startAutopilot() {
  autopilotState.lastResult = "waiting for the next slot";
  const tick = async () => {
    const { minutes, dateKey } = nowLocal();
    const due = TIMES().filter(t => { const [hh, mm] = t.split(":").map(Number); return minutes >= hh * 60 + (mm || 0); }).pop();
    if (!due) return;
    const slot = `${dateKey} ${due}`;
    if ((await getSetting("autopilot_last_slot", "")) === slot) return;
    await setSetting("autopilot_last_slot", slot);
    await runAutopilot();
  };
  const run = () => tick().catch(e => { autopilotState.lastResult = `error: ${e.message}`; console.warn("[autopilot]", e.message); });
  setTimeout(run, 4 * 60_000);
  setInterval(run, 5 * 60_000);
}
