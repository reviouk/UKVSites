/**
 * HubSpot call-back reminders — replacement for the third-party "Call Reminder"
 * private app (id 1165085) that ran on AWS.
 *
 * Contacts carry: call_back_date (date), call_back_hour (06..23), call_back_mins
 * (00/15/30/45), time_before_reminder (minutes, usually 3). Every minute, in
 * Europe/London wall-clock time (BST/GMT handled automatically):
 *
 *   now >= due - time_before_reminder  and  reminder_trigger != yes
 *       -> PATCH reminder_trigger = yes      (workflow 274725919 notifies the owner,
 *                                             waits 40 min, resets it to no)
 *   now >= due + NOT_MADE_AFTER_MIN  and no contact activity since the reminder
 *       -> PATCH call_not_made_trigger = yes (workflow 278726472 notifies managers)
 *
 * Nightly (23:45 London): call_not_made_trigger yes -> no for call-backs that are
 * now in the past, so the workflow can re-enrol on the next missed call-back.
 *
 * Every action is recorded in callback_events so nothing fires twice for the
 * same call-back, and the admin page shows today's schedule.
 */
import { cfg } from "./config.js";
import { q, all, one, getSetting } from "./db.js";

const HS = "https://api.hubapi.com";
const NOT_MADE_AFTER_MIN = Number(process.env.CALLBACK_NOT_MADE_AFTER_MIN || 30);
let ENABLED = String(process.env.CALLBACK_REMINDERS_ENABLED || "false") === "true";
export async function isEnabled() { const v = await getSetting("callbacks_enabled", null); ENABLED = v == null ? String(process.env.CALLBACK_REMINDERS_ENABLED || "false") === "true" : v === "true"; cbState.enabled = ENABLED; return ENABLED; }
const DRY = String(process.env.CALLBACK_DRY_RUN || "false") === "true";
const PROPS = ["email", "firstname", "lastname", "hubspot_owner_id", "call_back_date", "call_back_hour", "call_back_mins",
  "time_before_reminder", "reminder_trigger", "call_not_made_trigger", "notes_last_contacted", "hs_last_sales_activity_timestamp"];

export const cbState = { enabled: ENABLED, dry: DRY, lastTick: null, lastResult: "", today: [] };
let busy = false;

const headers = () => ({ Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" });

// ---- timezone helpers (no dependency) ---------------------------------------
/** Parts of a Date in the configured timezone. */
function partsIn(d, tz = cfg.tz) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
/** UTC instant for a wall-clock time in tz (DST-safe: solves for the offset). */
export function zonedToUtc(y, mo, d, h, mi, tz = cfg.tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const asIf = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
    const diff = asIf - Date.UTC(y, mo - 1, d, h, mi, 0);
    if (!diff) break;
    guess -= diff;
  }
  return new Date(guess);
}
export function todayKey(tz = cfg.tz) { const p = partsIn(new Date(), tz); return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }

// ---- HubSpot ---------------------------------------------------------------
async function searchCallbacks(dateKeys) {
  // call_back_date is a DATE property: stored as midnight UTC of that day.
  const out = [];
  for (const key of dateKeys) {
    const ms = Date.UTC(...key.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
    let after;
    do {
      const res = await fetch(`${HS}/crm/v3/objects/contacts/search`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "call_back_date", operator: "EQ", value: String(ms) }] }], properties: PROPS, limit: 200, after }),
      });
      if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      out.push(...(body.results || []));
      after = body.paging?.next?.after;
    } while (after);
  }
  return out;
}
async function patch(id, properties, why) {
  if (DRY) { console.log(`[callbacks] DRY ${why}: contact ${id}`, properties); return true; }
  const res = await fetch(`${HS}/crm/v3/objects/contacts/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ properties }) });
  if (!res.ok) { console.warn(`[callbacks] PATCH ${id} failed ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
  return true;
}

// ---- schedule --------------------------------------------------------------
/** Turn a contact into { due, remindAt, notMadeAt } in UTC, or null if no time set. */
export function schedule(c) {
  const p = c.properties;
  if (!p.call_back_date || p.call_back_hour == null || p.call_back_hour === "") return null;
  const [y, mo, d] = p.call_back_date.split("-").map(Number);
  const h = Number(p.call_back_hour), mi = Number(p.call_back_mins || 0);
  if (!Number.isFinite(h)) return null;
  const tbr = Number(p.time_before_reminder || 3);
  const due = zonedToUtc(y, mo, d, h, mi);
  return { due, remindAt: new Date(due.getTime() - tbr * 60e3), notMadeAt: new Date(due.getTime() + NOT_MADE_AFTER_MIN * 60e3), tbr };
}

async function already(contactId, dateKey, kind) {
  return !!(await one("SELECT 1 FROM callback_events WHERE contact_id=$1 AND callback_date=$2 AND kind=$3", [contactId, dateKey, kind]));
}
async function record(c, dateKey, kind, detail) {
  const p = c.properties;
  await q("INSERT INTO callback_events(contact_id,email,owner_id,callback_date,kind,detail) VALUES($1,$2,$3,$4,$5,$6)",
    [c.id, p.email || "", p.hubspot_owner_id || "", dateKey, kind, detail || ""]);
}

export async function tick() {
  if (busy || !cfg.hubspot.token) return;
  busy = true;
  cbState.lastTick = new Date();
  try {
    await isEnabled();
    const now = new Date();
    const today = todayKey();
    // Also look at yesterday so a call-back late in the evening still gets its "not made" check.
    const yest = new Date(now.getTime() - 86400e3);
    const yk = (() => { const p = partsIn(yest); return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; })();
    const contacts = await searchCallbacks([today, yk]);
    const view = [];
    let reminders = 0, notMade = 0;
    for (const c of contacts) {
      const s = schedule(c);
      const p = c.properties;
      if (!s) { view.push({ id: c.id, email: p.email, owner: p.hubspot_owner_id, date: p.call_back_date, time: "(no hour)", status: "skipped" }); continue; }
      const dateKey = p.call_back_date;
      let status = now < s.remindAt ? "waiting" : "due";
      // 1. Reminder
      if (now >= s.remindAt && now < s.notMadeAt && !(await already(c.id, dateKey, "reminder"))) {
        if (!ENABLED) status = "would remind (disabled)";
        else if (p.reminder_trigger === "yes") { await record(c, dateKey, "reminder", "already yes"); status = "reminder already set"; }
        else if (await patch(c.id, { reminder_trigger: "yes" }, "reminder")) { await record(c, dateKey, "reminder", `due ${s.due.toISOString()}`); reminders++; status = "reminder sent"; }
      } else if (await already(c.id, dateKey, "reminder")) status = "reminded";
      // 2. Not made
      if (now >= s.notMadeAt && now < new Date(s.due.getTime() + 20 * 3600e3) && !(await already(c.id, dateKey, "not_made"))) {
        const lastTouch = Math.max(Date.parse(p.notes_last_contacted || 0) || 0, Date.parse(p.hs_last_sales_activity_timestamp || 0) || 0);
        const contacted = lastTouch >= s.remindAt.getTime();
        if (contacted) { await record(c, dateKey, "not_made", "skipped: contact activity logged after reminder"); status = "call made"; }
        else if (!ENABLED) status = "would flag not made (disabled)";
        else if (p.call_not_made_trigger === "yes") { await record(c, dateKey, "not_made", "already yes"); status = "not-made already set"; }
        else if (await patch(c.id, { call_not_made_trigger: "yes" }, "not made")) { await record(c, dateKey, "not_made", `due ${s.due.toISOString()}`); notMade++; status = "flagged not made"; }
      } else if (await already(c.id, dateKey, "not_made")) status = (await one("SELECT detail FROM callback_events WHERE contact_id=$1 AND callback_date=$2 AND kind='not_made'", [c.id, dateKey]))?.detail?.startsWith("skipped") ? "call made" : "flagged not made";
      view.push({ id: c.id, email: p.email, owner: p.hubspot_owner_id, date: dateKey, time: `${p.call_back_hour}:${p.call_back_mins || "00"}`, due: s.due, status });
    }
    view.sort((a, b) => (a.due?.getTime() || 0) - (b.due?.getTime() || 0));
    cbState.today = view;
    cbState.lastResult = `${contacts.length} call-back(s) today/yesterday; ${reminders} reminder(s), ${notMade} not-made flag(s) this tick${ENABLED ? "" : " [DISABLED – observing only]"}${DRY ? " [DRY RUN]" : ""}`;
    if (reminders || notMade) console.log(`[callbacks] ${cbState.lastResult}`);

    // 3. Nightly reset at 23:45 London
    const lp = partsIn(now);
    if (lp.h === 23 && lp.mi >= 45 && !(await one("SELECT 1 FROM callback_events WHERE kind='nightly_reset' AND callback_date=$1", [today]))) {
      await q("INSERT INTO callback_events(contact_id,email,owner_id,callback_date,kind,detail) VALUES('0','','',$1,'nightly_reset','started')", [today]);
      await nightlyReset();
    }
  } catch (e) {
    cbState.lastResult = `error: ${e.message}`;
    console.warn("[callbacks]", e.message);
  } finally { busy = false; }
}

async function nightlyReset() {
  // call_not_made_trigger = yes on contacts whose call-back date is today or earlier -> no
  const todayMs = Date.UTC(...todayKey().split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  let after, n = 0;
  do {
    const res = await fetch(`${HS}/crm/v3/objects/contacts/search`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "call_not_made_trigger", operator: "EQ", value: "yes" }, { propertyName: "call_back_date", operator: "LTE", value: String(todayMs) }] }], properties: ["email"], limit: 200, after }),
    });
    if (!res.ok) { console.warn("[callbacks] nightly search failed", res.status); return; }
    const body = await res.json();
    for (const c of body.results || []) { if (ENABLED && await patch(c.id, { call_not_made_trigger: "no" }, "nightly reset")) n++; await sleep(120); }
    after = body.paging?.next?.after;
  } while (after);
  console.log(`[callbacks] nightly reset: ${n} contact(s) call_not_made_trigger -> no`);
}

export function startCallbacks() {
  if (!cfg.hubspot.token) { console.warn("[callbacks] no HUBSPOT_TOKEN; call-back reminders off"); return; }
  console.log(`[callbacks] reminders ${ENABLED ? "ENABLED" : "observing only (CALLBACK_REMINDERS_ENABLED=false)"}${DRY ? ", dry run" : ""}; tz ${cfg.tz}`);
  setTimeout(() => tick(), 15_000);
  setInterval(() => tick(), 60_000);
}
export async function recentEvents(limit = 100) {
  return all("SELECT * FROM callback_events ORDER BY id DESC LIMIT $1", [limit]);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
