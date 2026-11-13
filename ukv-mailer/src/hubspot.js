/**
 * HubSpot sync. Mirrors what the Instantly→HubSpot connector wrote so existing
 * lists (e.g. active list 1851 filtering on instantly_opened) keep working:
 *
 *   instantly_opened / instantly_clicked   boolean flags (only ever set true)
 *   instantly_engagement                   opened | clicked | replied
 *   instantly_campaign                     campaign name
 *   instantly_last_engaged                 YYYY-MM-DD
 *   external_lead_source                   Marketwatcher | investchronicles  (existing dropdown)
 *   data_source                            free text, e.g. "LUSHA LEADS"
 *   ukv_replied / ukv_unsubscribed         new boolean flags
 *   ukv_nurture_completed / _date          site that finished all steps + when (syncCompletions);
 *                                          feeds the per-website "Nurture completed" active lists
 *
 * Calls are queued and retried so a slow HubSpot never blocks tracking responses.
 */
import { cfg, SITES } from "./config.js";
import { q, all } from "./db.js";

const HS = "https://api.hubapi.com";
const headers = () => ({ Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" });
const enabled = () => cfg.hubspot.enabled && !!cfg.hubspot.token;

// HubSpot's `data_source` is a dropdown. Map our spreadsheet labels onto its
// existing option values; anything unmapped is left unset rather than failing the upsert.
const DATA_SOURCE_MAP = {
  "goldmine data - affluant": "Goldmine Data Affluent",
  "goldmine data affluent": "Goldmine Data Affluent",
  "hemmingway global": "Hemmingway Global",
  "gm clean": "Goldmine Data",
  "goldmine data": "Goldmine Data",
  "consumer data affluant": "Consumer data Affluant",
  "finely fettled": "FINELY FETTLED",
  "marko data - ken": "MARKO KEN",
  "marko ken": "MARKO KEN",
};
export const mapDataSource = (v) => DATA_SOURCE_MAP[String(v || "").trim().toLowerCase()] || "";

const BOOL_OPTIONS = [
  { label: "Yes", value: "true", displayOrder: 0, hidden: false },
  { label: "No", value: "false", displayOrder: 1, hidden: false },
];

export async function ensureProperties() {
  if (!enabled()) return;
  const props = [
    { name: "instantly_engagement", label: "Instantly Engagement", type: "string", fieldType: "text" },
    { name: "instantly_opened", label: "Instantly Opened", type: "bool", fieldType: "booleancheckbox", options: BOOL_OPTIONS },
    { name: "instantly_clicked", label: "Instantly Clicked", type: "bool", fieldType: "booleancheckbox", options: BOOL_OPTIONS },
    { name: "instantly_campaign", label: "Instantly Campaign", type: "string", fieldType: "text" },
    { name: "instantly_last_engaged", label: "Instantly Last Engaged", type: "string", fieldType: "text" },
    { name: "ukv_replied", label: "UKV Mailer Replied", type: "bool", fieldType: "booleancheckbox", options: BOOL_OPTIONS },
    { name: "ukv_unsubscribed", label: "UKV Mailer Unsubscribed", type: "bool", fieldType: "booleancheckbox", options: BOOL_OPTIONS },
    { name: "ukv_nurture_completed", label: "UKV Nurture Completed", type: "enumeration", fieldType: "select",
      options: Object.keys(SITES).map((k, i) => ({ label: SITES[k].label, value: k, displayOrder: i, hidden: false })) },
    { name: "ukv_nurture_completed_date", label: "UKV Nurture Completed Date", type: "date", fieldType: "date" },
  ];
  for (const p of props) {
    const res = await fetch(`${HS}/crm/v3/properties/contacts`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ...p, groupName: "contactinformation" }),
    });
    if (res.ok) console.log(`[hubspot] created property ${p.name}`);
    else if (res.status !== 409) console.warn(`[hubspot] could not create ${p.name}: ${res.status} ${await res.text()}`);
  }
  await ensureNurtureLists();
}

// ---- "Nurture completed" lists (one per website) --------------------------------
// 13 Nov 2026 (Rob): four engagement lists for the Nov 2026 campaigns - "Opened - <brand>" (1892 IC, 1893 MW)
// and "Clicked - <brand>" (1900 IC, 1901 MW). Not "nurture completed" any more.
const ENGAGEMENT_LISTS = [{ kind: "Opened", prop: "instantly_opened" }, { kind: "Clicked", prop: "instantly_clicked" }];
export const nurtureListName = (site, kind = "Opened") => `${kind} - ${SITES[site]?.label || site}`;
const LEAD_SOURCE = { investchronicles: "investchronicles", marketwatcher: "Marketwatcher" };
const engagedBranch = (prop, site) => ({ filterBranchType: "AND", filterBranches: [], filters: [
  { filterType: "PROPERTY", property: prop, operation: { operationType: "BOOL", operator: "IS_EQUAL_TO", value: true } },
  { filterType: "PROPERTY", property: "external_lead_source", operation: { operationType: "ENUMERATION", operator: "IS_ANY_OF", values: [LEAD_SOURCE[site] || site] } },
  { filterType: "PROPERTY", property: "instantly_campaign", operation: { operationType: "MULTISTRING", operator: "CONTAINS", values: ["Nov 2026"] } } ] });
export const nurtureState = { lists: {}, lastRun: null, lastResult: "" };

async function ensureNurtureLists() {
  for (const site of Object.keys(SITES)) for (const { kind, prop } of ENGAGEMENT_LISTS) {
    const name = nurtureListName(site, kind), key = `${site}:${kind}`;
    const found = await fetch(`${HS}/crm/v3/lists/object-type-id/0-1/name/${encodeURIComponent(name)}`, { headers: headers() });
    if (found.ok) { nurtureState.lists[key] = (await found.json()).list?.listId; continue; }
    const res = await fetch(`${HS}/crm/v3/lists`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({
        name, objectTypeId: "0-1", processingType: "DYNAMIC",
        filterBranch: { filterBranchType: "OR", filters: [], filterBranches: [engagedBranch(prop, site)] },
      }),
    });
    if (res.ok) { nurtureState.lists[key] = (await res.json()).list?.listId; console.log(`[hubspot] created list "${name}" (${nurtureState.lists[key]})`); }
    else console.warn(`[hubspot] could not create list "${name}": ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Tag every contact whose enrolment has had all steps (status 'completed') with
 * ukv_nurture_completed=<site> + date, so they drop into that website's list.
 * Bounced contacts are skipped. Each enrolment is tagged once (enrolments.hubspot_completed_at).
 */
export async function syncCompletions() {
  if (!enabled()) { nurtureState.lastResult = "HubSpot disabled"; return 0; }
  nurtureState.lastRun = new Date();
  let total = 0;
  for (;;) {
    const rows = await all(`SELECT e.id, c.email, c.first_name, c.last_name, c.company, c.phone, c.data_source, ca.site, ca.name campaign,
        (SELECT max(s.sent_at) FROM sends s WHERE s.enrolment_id=e.id AND s.status<>'failed') finished_at
      FROM enrolments e JOIN contacts c ON c.id=e.contact_id JOIN campaigns ca ON ca.id=e.campaign_id
      WHERE e.status='completed' AND e.hubspot_completed_at IS NULL AND c.status<>'bounced'
        AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.enrolment_id=e.id AND s.status='bounced')
      ORDER BY e.id LIMIT 100`);
    if (!rows.length) break;
    const inputs = rows.map(r => ({ idProperty: "email", id: r.email, properties: {
      email: r.email,
      ...(r.first_name ? { firstname: r.first_name } : {}),
      ...(r.last_name ? { lastname: r.last_name } : {}),
      ...(r.company ? { company: r.company } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      ...(SITES[r.site]?.leadSource ? { external_lead_source: SITES[r.site].leadSource } : {}),
      ...(mapDataSource(r.data_source) ? { data_source: mapDataSource(r.data_source) } : {}),
      instantly_campaign: r.campaign,
      ukv_nurture_completed: r.site,
      ukv_nurture_completed_date: new Date(r.finished_at || Date.now()).toISOString().slice(0, 10),
    } }));
    const res = await fetch(`${HS}/crm/v3/objects/contacts/batch/upsert`, { method: "POST", headers: headers(), body: JSON.stringify({ inputs }) });
    if (res.status === 429) { await sleep(10000); continue; }
    if (!res.ok) throw new Error(`completion upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await q("UPDATE enrolments SET hubspot_completed_at=now() WHERE id = ANY($1)", [rows.map(r => r.id)]);
    total += rows.length;
    await sleep(300);
  }
  nurtureState.lastResult = `${new Date().toISOString().slice(0, 16)}: tagged ${total}`;
  if (total) console.log(`[hubspot] nurture completed: tagged ${total} contact(s)`);
  return total;
}

export function startCompletionSync() {
  const run = () => syncCompletions().catch(e => { nurtureState.lastResult = `error: ${e.message}`; console.warn("[hubspot]", e.message); });
  setTimeout(run, 120_000);
  setInterval(run, 30 * 60_000);
}

// ---- queue -----------------------------------------------------------------
const queue = [];
let draining = false;

/** engagement: opened | clicked | replied | unsubscribed */
export function syncEngagement({ contact, campaign, engagement, site }) {
  if (!enabled() || !contact?.email) return;
  queue.push({ contact, campaign, engagement, site, tries: 0 });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await upsert(job);
    } catch (e) {
      job.tries++;
      console.warn(`[hubspot] ${job.engagement} ${job.contact.email} failed (${job.tries}): ${e.message.slice(0, 200)}`);
      if (job.tries < 3) { queue.push(job); await sleep(2000 * job.tries); }
      else await q("INSERT INTO events(contact_id,type,detail) VALUES($1,'hubspot_error',$2)", [job.contact.id, e.message.slice(0, 500)]).catch(() => {});
    }
    await sleep(150); // stay well under HubSpot's burst limit
  }
  draining = false;
}

async function upsert({ contact, campaign, engagement, site }) {
  const c = contact;
  const leadSource = SITES[site]?.leadSource || "";
  const when = new Date().toISOString().split("T")[0];
  const properties = {
    email: c.email,
    ...(c.first_name ? { firstname: c.first_name } : {}),
    ...(c.last_name ? { lastname: c.last_name } : {}),
    ...(c.company ? { company: c.company } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(campaign?.name ? { instantly_campaign: campaign.name } : {}),
    ...(leadSource ? { external_lead_source: leadSource } : {}),
    ...(mapDataSource(c.data_source) ? { data_source: mapDataSource(c.data_source) } : {}),
    instantly_last_engaged: when,
  };
  if (engagement === "opened") Object.assign(properties, { instantly_opened: true, instantly_engagement: "opened" });
  if (engagement === "clicked") Object.assign(properties, { instantly_clicked: true, instantly_engagement: "clicked" });
  if (engagement === "replied") Object.assign(properties, { ukv_replied: true, instantly_engagement: "replied" });
  if (engagement === "unsubscribed") Object.assign(properties, { ukv_unsubscribed: true });

  const res = await fetch(`${HS}/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ inputs: [{ idProperty: "email", id: c.email, properties }] }),
  });
  if (res.status === 429) { await sleep(10000); throw new Error("rate limited"); }
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
