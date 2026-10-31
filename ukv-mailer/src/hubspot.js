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
 *
 * Calls are queued and retried so a slow HubSpot never blocks tracking responses.
 */
import { cfg, SITES } from "./config.js";
import { q } from "./db.js";

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
  ];
  for (const p of props) {
    const res = await fetch(`${HS}/crm/v3/properties/contacts`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ...p, groupName: "contactinformation" }),
    });
    if (res.ok) console.log(`[hubspot] created property ${p.name}`);
    else if (res.status !== 409) console.warn(`[hubspot] could not create ${p.name}: ${res.status} ${await res.text()}`);
  }
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
