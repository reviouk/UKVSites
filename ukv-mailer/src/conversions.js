/**
 * Conversions = HubSpot form submissions by people we emailed. Every hour we
 * batch-read our emailed contacts from HubSpot and record the first conversion
 * that happened AFTER our first email to them.
 *
 *   contacts.converted_at / contacts.conversion_event
 *
 * The websites' forms don't ask for a phone number, so when someone converts and their
 * HubSpot record has no phone, we copy the number from our spreadsheet data onto it.
 */
import { cfg } from "./config.js";
import { q, all, setSetting } from "./db.js";

const HS = "https://api.hubapi.com";
// HubSpot workflow 1840795533 "Whisky Send Brochure - MarketWatcher and Invest Chronicle" only enrols contacts whose
// LEAD SOURCE (external_lead_source) is Marketwatcher / investchronicles AND who filled the site form. Contacts who fill the
// form without that tag never get the brochure, so we set it from the form they filled (13 Nov 2026).
const FORM_BRAND = (name) => /watcher/i.test(name || "") ? "Marketwatcher" : /chronicle/i.test(name || "") ? "investchronicles" : "";
const OUR_SOURCES = new Set(["Marketwatcher", "investchronicles"]);
export const convState = { lastRun: null, lastResult: "" };
let busy = false;

export function startConversionSync() {
  if (!cfg.hubspot.enabled || !cfg.hubspot.token) return;
  setTimeout(() => syncConversions().catch(e => console.warn("[conversions]", e.message)), 60_000);
  setInterval(() => syncConversions().catch(e => console.warn("[conversions]", e.message)), 10 * 60_000);
}

export async function syncConversions() {
  if (busy || !cfg.hubspot.token) return;
  busy = true;
  convState.lastRun = new Date();
  try {
    await q("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS conversion_event TEXT, ADD COLUMN IF NOT EXISTS instantly_sent_at TIMESTAMPTZ");
    // Everyone we have emailed who has not converted yet (most recent first; cap per run to respect rate limits)
    const rows = await all(`
      SELECT c.id, c.email, c.phone, LEAST(min(s.sent_at), c.instantly_sent_at) AS first_sent
        FROM contacts c LEFT JOIN sends s ON s.contact_id = c.id AND s.status <> 'failed'
       WHERE c.converted_at IS NULL AND (s.id IS NOT NULL OR c.instantly_sent_at IS NOT NULL)
       GROUP BY c.id ORDER BY 3 DESC LIMIT 20000`);
    let found = 0, checked = 0, phones = 0, tagged = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const res = await fetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
        method: "POST", headers: { Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ idProperty: "email", properties: ["email", "phone", "first_conversion_date", "recent_conversion_date", "recent_conversion_event_name", "first_conversion_event_name", "num_conversion_events", "external_lead_source"], inputs: chunk.map(r => ({ id: r.email })) }),
      });
      if (res.status === 429) { await sleep(10000); i -= 100; continue; }
      if (!res.ok && res.status !== 207) throw new Error(`batch read ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      checked += chunk.length;
      const byEmail = new Map(chunk.map(r => [r.email, r]));
      const phoneUpdates = [];
      for (const r of body.results || []) {
        const p = r.properties || {};
        const email = (p.email || "").toLowerCase();
        const ours = byEmail.get(email);
        if (!ours || !Number(p.num_conversion_events || 0)) continue;
        const when = p.recent_conversion_date || p.first_conversion_date;
        if (!when) continue;
        const whenD = new Date(when);
        // Only count submissions made after our first email to them
        if (whenD < new Date(ours.first_sent)) continue;
        await q("UPDATE contacts SET converted_at=$2, conversion_event=$3, updated_at=now() WHERE id=$1 AND converted_at IS NULL",
          [ours.id, whenD, (p.recent_conversion_event_name || p.first_conversion_event_name || "form").slice(0, 200)]);
        await q("INSERT INTO events(contact_id,type,detail) VALUES($1,'conversion',$2)", [ours.id, (p.recent_conversion_event_name || "form").slice(0, 300)]);
        found++;
        const props = {};
        const phone = String(ours.phone || "").trim();
        if (phone && !String(p.phone || "").trim()) props.phone = phone;
        const brand = FORM_BRAND(p.recent_conversion_event_name) || FORM_BRAND(p.first_conversion_event_name);
        if (brand && p.external_lead_source !== brand) { props.external_lead_source = brand; tagged++; }
        if (Object.keys(props).length) phoneUpdates.push({ id: r.id, properties: props });
      }
      if (phoneUpdates.length) {
        const up = await fetch(`${HS}/crm/v3/objects/contacts/batch/update`, {
          method: "POST", headers: { Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: phoneUpdates }),
        });
        if (up.ok) phones += phoneUpdates.filter(u => u.properties.phone).length;
        else console.warn(`[conversions] phone update ${up.status}: ${(await up.text()).slice(0, 200)}`);
      }
      await sleep(250);
    }
    tagged += await tagFormFillers();
    convState.lastResult = `${checked} contacts checked, ${found} new conversion(s), ${phones} phone number(s) added, ${tagged} lead source(s) tagged`;
    await setSetting("conversions_last_run", new Date().toISOString());
    if (found) console.log(`[conversions] ${convState.lastResult}`);
  } catch (e) {
    convState.lastResult = `error: ${e.message}`;
    throw e;
  } finally { busy = false; }
}
/** Form fillers on marketwatcher.co.uk / investchronicles.com with an empty LEAD SOURCE -> set it from the form name. */
async function tagFormFillers() {
  const H = { Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" };
  const groups = [];
  for (const prop of ["recent_conversion_event_name", "first_conversion_event_name"]) for (const tok of ["*watcher*", "*chronicle*"])
    groups.push({ filters: [{ propertyName: prop, operator: "CONTAINS_TOKEN", value: tok }, { propertyName: "external_lead_source", operator: "NOT_HAS_PROPERTY" },
      { propertyName: "recent_conversion_date", operator: "GTE", value: String(Date.parse("2026-11-01T00:00:00Z")) }] });   // campaigns went live 1 Nov; earlier fills were site tests
  const res = await fetch(`${HS}/crm/v3/objects/contacts/search`, { method: "POST", headers: H,
    body: JSON.stringify({ filterGroups: groups, properties: ["recent_conversion_event_name", "first_conversion_event_name"], limit: 100 }) });
  if (!res.ok) { console.warn(`[conversions] form-filler search ${res.status}`); return 0; }
  const inputs = ((await res.json()).results || []).map(r => ({ id: r.id, properties: { external_lead_source: FORM_BRAND(r.properties.recent_conversion_event_name) || FORM_BRAND(r.properties.first_conversion_event_name) } }))
    .filter(u => OUR_SOURCES.has(u.properties.external_lead_source));
  if (!inputs.length) return 0;
  const up = await fetch(`${HS}/crm/v3/objects/contacts/batch/update`, { method: "POST", headers: H, body: JSON.stringify({ inputs }) });
  if (!up.ok) { console.warn(`[conversions] lead source tag ${up.status}: ${(await up.text()).slice(0, 200)}`); return 0; }
  console.log(`[conversions] tagged lead source on ${inputs.length} form filler(s)`);
  return inputs.length;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
