#!/usr/bin/env node
/**
 * Backfill Instantly campaign "openers" into a HubSpot contact list.
 *
 * Why this exists: Instantly webhooks are forward-only, so the ~50 opens that
 * happened BEFORE the webhook was added never synced. This pulls them via the
 * Instantly v2 API and pushes them into HubSpot.
 *
 * Required env vars:
 *   INSTANTLY_API_KEY   Instantly v2 API key (Settings → Integrations → API)
 *   HUBSPOT_TOKEN       HubSpot private-app token with crm.objects.contacts.write
 *                       + crm.lists.write scopes (portal 4633795)
 *   HUBSPOT_LIST_ID     numeric ILS list id to add the contacts to
 *
 * Optional:
 *   CAMPAIGN_ID         defaults to the campaign in the analytics link
 *   MIN_OPENS           default 1 (set 0 to sync every lead regardless of opens)
 *   DRY_RUN             "1" to print what would happen without writing to HubSpot
 *
 * Run:  node tools/instantly-to-hubspot.mjs
 */

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;
const HUBSPOT_LIST_ID   = process.env.HUBSPOT_LIST_ID;
const CAMPAIGN_ID       = process.env.CAMPAIGN_ID || "ce0cf494-ddd6-4337-bd2a-34188168c32e";
const MIN_OPENS         = Number(process.env.MIN_OPENS ?? "1");
const DRY_RUN           = process.env.DRY_RUN === "1";

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const HUBSPOT_BASE   = "https://api.hubapi.com";

function need(name, val) {
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
need("INSTANTLY_API_KEY", INSTANTLY_API_KEY);
if (!DRY_RUN) { need("HUBSPOT_TOKEN", HUBSPOT_TOKEN); }
// HUBSPOT_LIST_ID is optional: only used for MANUAL/static lists. DYNAMIC
// (active) lists auto-populate from contact properties, so we skip the add.

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error(`${opts?.method || "GET"} ${url} -> ${res.status}: ${text}`);
  return body;
}

/** Page through all leads in the campaign (Instantly v2 cursor pagination). */
async function fetchCampaignLeads() {
  const leads = [];
  let starting_after;
  do {
    const body = await jfetch(`${INSTANTLY_BASE}/leads/list`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${INSTANTLY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ campaign: CAMPAIGN_ID, limit: 100, starting_after }),
    });
    const items = body.items || body.data || [];
    leads.push(...items);
    starting_after = body.next_starting_after || body.starting_after || null;
    if (!items.length) break;
  } while (starting_after);
  return leads;
}

function openCount(lead) {
  return Number(lead.email_open_count ?? lead.open_count ?? lead.opens ?? 0);
}

async function hubspotUpsert(leads) {
  const inputs = leads.map(({ email, firstname, lastname, company }) => {
    const properties = {
      email,
      // the property the active list 1851 actually filters on
      instantly_opened: "true",
      instantly_campaign: CAMPAIGN_ID,
      hs_lead_status: "Opened",
      lifecyclestage: "lead",
    };
    // Only set name fields when Instantly actually has them, so we never
    // overwrite a good HubSpot name with a blank.
    if (firstname) properties.firstname = firstname;
    if (lastname)  properties.lastname  = lastname;
    if (company)   properties.company   = company;
    return { idProperty: "email", id: email, properties };
  });
  const res = await jfetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/upsert`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  return (res.results || []).map(r => r.id);
}

async function addToList(contactIds) {
  return jfetch(`${HUBSPOT_BASE}/crm/v3/lists/${HUBSPOT_LIST_ID}/memberships/add`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(contactIds),
  });
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

(async () => {
  console.log(`Fetching leads for campaign ${CAMPAIGN_ID} ...`);
  const leads = await fetchCampaignLeads();
  console.log(`  ${leads.length} total leads in campaign`);

  const openers = leads.filter(l => openCount(l) >= MIN_OPENS && l.email);
  // Dedupe by email, mapping each to the name fields Instantly provides.
  const byEmail = new Map();
  for (const l of openers) {
    const email = l.email.trim().toLowerCase();
    if (byEmail.has(email)) continue;
    byEmail.set(email, {
      email,
      firstname: (l.first_name || l.firstName || "").trim(),
      lastname:  (l.last_name  || l.lastName  || "").trim(),
      company:   (l.company_name || l.companyName || l.company || "").trim(),
    });
  }
  const records = [...byEmail.values()];
  console.log(`  ${records.length} unique leads with >= ${MIN_OPENS} open(s)`);

  if (DRY_RUN) {
    console.log("DRY_RUN — would upsert these to HubSpot and add to list:");
    records.forEach(r => console.log(`   ${r.email}  [${r.firstname} ${r.lastname}]`.trimEnd()));
    return;
  }
  if (!records.length) { console.log("Nothing to sync."); return; }

  const ids = [];
  for (const part of chunk(records, 100)) {
    const got = await hubspotUpsert(part);
    ids.push(...got);
    console.log(`  upserted ${got.length} contacts`);
  }

  if (HUBSPOT_LIST_ID) {
    try {
      for (const part of chunk(ids, 100)) {
        await addToList(part);
        console.log(`  added ${part.length} to list ${HUBSPOT_LIST_ID}`);
      }
    } catch (e) {
      console.log(`  (skipped list add — likely a DYNAMIC list that auto-populates: ${e.message.split("\n")[0]})`);
    }
  }

  console.log(`Done. Upserted ${ids.length} openers (instantly_opened=true). Dynamic list 1851 will pull them in automatically.`);
})().catch(err => { console.error(err); process.exit(1); });
