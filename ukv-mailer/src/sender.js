/**
 * Paced sender. Runs once a minute. Inside the send window it works out how many
 * emails should have gone out by now (DAILY_TOTAL spread evenly across the window),
 * sends the shortfall with random gaps, and never exceeds the per-mailbox cap.
 */
import { randomBytes } from "node:crypto";
import { cfg, inSendWindow, windowElapsed, windowMinutes, startOfLocalDay, nowLocal } from "./config.js";
import { pool, q, one, all, getSetting, setSetting } from "./db.js";
import { buildEmail, contactVars } from "./templates.js";
import { sendMail } from "./mailer.js";
import { routes, HOLD } from "./routing.js";

const MAX_PER_TICK = 12;

/**
 * Warm-up schedule for a mailbox by age since warmup_from (local date):
 * week 1: 5/day, week 2: 10, week 3: 20, week 4: 30, then no warm-up limit.
 */
export const WARMUP_STEPS = [5, 10, 20, 30];
export function warmupCap(m) {
  if (!m.warmup_from) return Infinity;
  const from = new Date(m.warmup_from instanceof Date ? m.warmup_from.toISOString().slice(0, 10) : String(m.warmup_from).slice(0, 10));
  const day = Math.floor((new Date(nowLocal().dateKey) - from) / 86400e3);   // 0 = first day
  if (day < 0) return 0;
  const week = Math.floor(day / 7);
  return week < WARMUP_STEPS.length ? WARMUP_STEPS[week] : Infinity;
}
/** Hard ceiling for a mailbox today, before the daily total is shared out. */
export function hardCap(m, mult = 1) {
  return Math.max(0, Math.min(m.daily_cap * mult, cfg.mailboxDailyCap, warmupCap(m) * mult));
}

/**
 * One-day boost: setting boost_day = "YYYY-MM-DD:<multiplier>" multiplies that day's total and
 * every mailbox cap; it lapses by itself the next day (no clean-up needed).
 */
export async function boostToday() {
  const m = String(await getSetting("boost_day", "") || "").match(/^(\d{4}-\d{2}-\d{2}):(\d+(?:\.\d+)?)$/);
  return m && m[1] === nowLocal().dateKey ? Math.max(1, Number(m[2])) : 1;
}

/**
 * Share the day's total across active mailboxes by water-filling: a mailbox with a
 * low cap (warm-up) takes only its cap and the remainder is spread over the others.
 * Returns Map(id -> allowance) with a little headroom so the pace can be met.
 */
export async function allowances() {
  const { total } = await effectiveDailyTotal();
  const mult = await boostToday();
  const boxes = await all("SELECT * FROM mailboxes WHERE enabled AND smtp_pass IS NOT NULL AND smtp_pass <> '' ORDER BY id");
  const out = new Map();
  let remaining = total, left = boxes.length;
  for (const m of [...boxes].sort((a, b) => hardCap(a, mult) - hardCap(b, mult))) {
    const share = Math.min(hardCap(m, mult), Math.ceil(remaining / Math.max(1, left)));
    out.set(m.id, Math.min(hardCap(m, mult), share + 3));
    remaining -= share; left--;
  }
  return { total, boxes, allowances: out };
}

/** Which "site|pool" combinations still have a mailbox with room today. */
async function lanesWithCapacity() {
  const { boxes, allowances: al } = await allowances();
  const since = startOfLocalDay();
  const sent = await all("SELECT mailbox_id, count(*)::int n FROM sends WHERE sent_at >= $1 AND status <> 'failed' GROUP BY mailbox_id", [since]);
  const n = Object.fromEntries(sent.map(r => [r.mailbox_id, r.n]));
  const lanes = new Set();
  for (const m of boxes) if ((n[m.id] || 0) < (al.get(m.id) || 0)) lanes.add(`${m.site}|${m.pool}`);
  return [...lanes];
}       // burst ceiling per minute (1000/day over 9.5h is ~1.75/min)
let running = false;
export const state = { lastTick: null, lastResult: "", sentToday: 0 };

export function startSender() {
  tick().catch(e => console.error("[sender] tick error", e));
  setInterval(() => tick().catch(e => console.error("[sender] tick error", e)), 60_000);
}

export async function todaysCounts() {
  const since = startOfLocalDay();
  const total = await one("SELECT count(*)::int AS n FROM sends WHERE sent_at >= $1 AND status <> 'failed'", [since]);
  const perMailbox = await all(
    `SELECT m.id, m.email, m.display_name, m.site, m.enabled, m.daily_cap, m.last_error, m.last_error_at,
            count(s.id) FILTER (WHERE s.sent_at >= $1 AND s.status <> 'failed')::int AS sent_today
       FROM mailboxes m LEFT JOIN sends s ON s.mailbox_id = m.id
      GROUP BY m.id ORDER BY m.site, m.email`, [since]);
  return { total: total.n, perMailbox, since };
}

/**
 * Ramp-up: the first `ramp_hold_days` days after the first send run at
 * `ramp_start_total`/day, then +`ramp_step` per calendar day up to `daily_total`.
 * Returns { total, day, phase }.
 */
export async function effectiveDailyTotal() {
  const base = await baseDailyTotal(), mult = await boostToday();
  return mult === 1 ? base : { ...base, total: Math.round(base.total * mult), phase: `${base.phase}; boosted x${mult} today` };
}
async function baseDailyTotal() {
  const target = Number(await getSetting("daily_total", cfg.dailyTotal));
  const start = Number(await getSetting("ramp_start_total", 300));
  const hold = Number(await getSetting("ramp_hold_days", 7));
  const step = Number(await getSetting("ramp_step", 100));
  const startedAt = await getSetting("ramp_started_on", null);   // YYYY-MM-DD local
  if (!startedAt || start >= target) return { total: target, day: null, phase: "full" };
  const day = Math.floor((new Date(nowLocal().dateKey) - new Date(startedAt)) / 86400e3) + 1; // day 1 = first send day
  if (day <= hold) return { total: Math.min(start, target), day, phase: `hold (${start}/day for ${hold} days)` };
  const total = Math.min(target, start + step * (day - hold));
  return { total, day, phase: total >= target ? "full" : `ramping +${step}/day` };
}

async function paused() {
  if (!cfg.sendingEnabled) return "SENDING_ENABLED=false";
  if ((await getSetting("paused", "false")) === "true") return "paused from admin";
  return "";
}

export async function tick() {
  if (running) return;
  running = true;
  state.lastTick = new Date();
  try {
    const why = await paused();
    if (why) { state.lastResult = why; return; }
    if (!inSendWindow()) { state.lastResult = "outside send window"; return; }

    const { total: sentToday } = await todaysCounts();
    state.sentToday = sentToday;
    // Start the ramp clock only when something can really send, not on the first idle tick.
    if (!(await getSetting("ramp_started_on", null))) {
      const work = await one(`SELECT 1 FROM enrolments e JOIN campaigns c ON c.id=e.campaign_id
                               WHERE e.status='active' AND c.status='active' LIMIT 1`);
      if (!work) { state.lastResult = "nothing enrolled in an active campaign"; return; }
      await setSetting("ramp_started_on", nowLocal().dateKey);
    }
    const { total: dailyTotal } = await effectiveDailyTotal();
    const shouldHaveSent = Math.ceil(dailyTotal * (windowElapsed() + 1) / windowMinutes());
    let toSend = Math.min(MAX_PER_TICK, dailyTotal - sentToday, shouldHaveSent - sentToday);
    if (toSend <= 0) { state.lastResult = `on pace (${sentToday}/${dailyTotal})`; return; }

    const lanes = await lanesWithCapacity();
    if (!lanes.length) { state.lastResult = `all mailboxes at cap (${sentToday}/${dailyTotal})`; return; }
    const route = await routes();                   // provider -> pool | hold
    let sent = 0, skipped = 0;
    const gap = Math.floor(55_000 / (toSend + 1)); // spread this minute's sends out
    for (let i = 0; i < toSend; i++) {
      const r = await sendOne(lanes, route);
      if (r === "sent") sent++;
      else if (r === "nothing-due" || r === "no-mailbox") { state.lastResult = r; break; }
      else skipped++;
      await sleep(gap * (0.5 + Math.random()));
    }
    state.sentToday = sentToday + sent;
    state.lastResult = `sent ${sent}, skipped ${skipped}; ${state.sentToday}/${dailyTotal} today`;
    if (sent || skipped) console.log(`[sender] ${state.lastResult}`);
  } finally {
    running = false;
  }
}

/**
 * Pick one due enrolment, lock it, send it. Returns sent | nothing-due | no-mailbox | skipped.
 * `lanes` = "site|pool" combos with capacity today; `route` = provider -> pool (or hold).
 * The contact's provider (unclassified counts as "other") chooses the pool; held providers
 * and lanes without capacity are left in the queue untouched.
 */
async function sendOne(lanes, route) {
  const providers = Object.keys(route), poolsFor = providers.map(p => route[p]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT e.*, c.name AS campaign_name, c.site AS campaign_site, c.daily_cap AS campaign_cap, COALESCE(c.send_pool, r.pool) AS send_pool,
             ct.email AS contact_email, ct.first_name, ct.last_name, ct.company, ct.phone, ct.data_source, ct.status AS contact_status
        FROM enrolments e
        JOIN campaigns c ON c.id = e.campaign_id AND c.status = 'active'
        JOIN contacts ct ON ct.id = e.contact_id
        JOIN unnest($2::text[], $3::text[]) AS r(provider, pool) ON r.provider = COALESCE(ct.mail_provider, 'other')
       WHERE e.status = 'active' AND e.next_due_at <= now()
         AND ct.status = 'active'
         AND r.pool <> $4
         AND (c.site || '|' || COALESCE(c.send_pool, r.pool)) = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = ct.email)
       ORDER BY e.current_step DESC, e.next_due_at ASC
       LIMIT 1 FOR UPDATE OF e SKIP LOCKED`, [lanes, providers, poolsFor, HOLD]);
    const en = rows[0];
    if (!en) { await client.query("ROLLBACK"); return "nothing-due"; }

    // Per-campaign cap (optional)
    if (en.campaign_cap) {
      const { rows: [cc] } = await client.query(
        "SELECT count(*)::int n FROM sends WHERE campaign_id=$1 AND sent_at >= $2 AND status<>'failed'", [en.campaign_id, startOfLocalDay()]);
      if (cc.n >= en.campaign_cap) {
        await client.query("UPDATE enrolments SET next_due_at = now() + interval '1 day' WHERE id=$1", [en.id]);
        await client.query("COMMIT"); return "skipped";
      }
    }

    const step = await one("SELECT * FROM steps WHERE campaign_id=$1 AND position=$2", [en.campaign_id, en.current_step + 1]);
    if (!step) {
      await client.query("UPDATE enrolments SET status='completed' WHERE id=$1", [en.id]);
      await client.query("COMMIT"); return "skipped";
    }

    const mailbox = await pickMailbox(client, en);
    if (!mailbox) { await client.query("ROLLBACK"); return "no-mailbox"; }

    const contact = { id: en.contact_id, email: en.contact_email, first_name: en.first_name, last_name: en.last_name, company: en.company, phone: en.phone, data_source: en.data_source };
    const token = randomBytes(9).toString("base64url");
    const vars = contactVars(contact, mailbox, en.campaign_site);
    const built = buildEmail({ step, contact, mailbox, site: en.campaign_site, token, vars });
    // Follow-ups threaded as "Re: <original subject>" under step 1
    const threaded = step.position > 1 && step.reply_in_thread && en.thread_message_id;
    const subject = threaded && en.thread_subject ? (step.subject.trim() ? built.subject : `Re: ${en.thread_subject}`) : built.subject;

    let messageId = null, status = "sent", error = null;
    try {
      ({ messageId } = await sendMail({
        mailbox, to: contact.email, subject, html: built.html, text: built.text, unsubUrl: built.unsubUrl,
        inReplyTo: threaded ? en.thread_message_id : undefined,
      }));
    } catch (e) {
      status = "failed"; error = String(e.message || e).slice(0, 500);
      console.warn(`[sender] ${mailbox.email} -> ${contact.email} failed: ${error}`);
      await client.query("UPDATE mailboxes SET last_error=$2, last_error_at=now() WHERE id=$1", [mailbox.id, error]);
      if (/535|auth|invalid login|credentials/i.test(error)) {
        await client.query("UPDATE mailboxes SET enabled=false WHERE id=$1", [mailbox.id]);
        console.warn(`[sender] disabled mailbox ${mailbox.email} after auth failure`);
      }
    }

    await client.query(
      `INSERT INTO sends(token,enrolment_id,campaign_id,contact_id,mailbox_id,step_position,message_id,subject,status,error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [token, en.id, en.campaign_id, en.contact_id, mailbox.id, step.position, messageId, subject, status, error]);

    if (status === "sent") {
      const next = await one("SELECT * FROM steps WHERE campaign_id=$1 AND position=$2", [en.campaign_id, step.position + 1]);
      await client.query(
        `UPDATE enrolments SET current_step=$2, mailbox_id=$3,
                thread_message_id = COALESCE(thread_message_id, $4), thread_subject = COALESCE(thread_subject, $5),
                status = $6, next_due_at = $7
          WHERE id=$1`,
        [en.id, step.position, mailbox.id, messageId, subject, next ? "active" : "completed",
         next ? new Date(Date.now() + Math.max(1, next.delay_days) * 86400e3) : new Date()]);
      await client.query("UPDATE contacts SET updated_at=now() WHERE id=$1", [en.contact_id]);
    } else {
      // retry this contact in an hour (different mailbox will be picked if this one is disabled)
      await client.query("UPDATE enrolments SET next_due_at = now() + interval '1 hour' WHERE id=$1", [en.id]);
    }
    await client.query("COMMIT");
    return status === "sent" ? "sent" : "skipped";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Sticky persona if possible, else the least-used enabled mailbox for the campaign's site that is under today's allowance. */
async function pickMailbox(client, en) {
  const since = startOfLocalDay();
  const { rows } = await client.query(`
    SELECT m.*, count(s.id) FILTER (WHERE s.sent_at >= $2 AND s.status <> 'failed')::int AS sent_today
      FROM mailboxes m LEFT JOIN sends s ON s.mailbox_id = m.id
     WHERE m.enabled AND m.site = $1 AND m.pool = $3 AND m.smtp_pass IS NOT NULL AND m.smtp_pass <> ''
     GROUP BY m.id`, [en.campaign_site, since, en.send_pool]);
  if (!rows.length) return null;
  const { allowances: al } = await allowances();
  const eligible = rows.filter(m => m.sent_today < (al.get(m.id) || 0));
  if (!eligible.length) return null;
  const sticky = eligible.find(m => m.id === en.mailbox_id);
  if (sticky) return sticky;
  eligible.sort((a, b) => a.sent_today - b.sent_today || Math.random() - 0.5);
  return eligible[0];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
