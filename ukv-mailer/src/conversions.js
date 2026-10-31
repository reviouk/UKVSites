/**
 * Conversions = HubSpot form submissions by people we emailed. Every hour we
 * batch-read our emailed contacts from HubSpot and record the first conversion
 * that happened AFTER our first email to them.
 *
 *   contacts.converted_at / contacts.conversion_event
 */
import { cfg } from "./config.js";
import { q, all, setSetting } from "./db.js";

const HS = "https://api.hubapi.com";
export const convState = { lastRun: null, lastResult: "" };
let busy = false;

export function startConversionSync() {
  if (!cfg.hubspot.enabled || !cfg.hubspot.token) return;
  setTimeout(() => syncConversions().catch(e => console.warn("[conversions]", e.message)), 60_000);
  setInterval(() => syncConversions().catch(e => console.warn("[conversions]", e.message)), 60 * 60_000);
}

export async function syncConversions() {
  if (busy || !cfg.hubspot.token) return;
  busy = true;
  convState.lastRun = new Date();
  try {
    await q("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS conversion_event TEXT");
    // Everyone we have emailed who has not converted yet (most recent first; cap per run to respect rate limits)
    const rows = await all(`
      SELECT c.id, c.email, min(s.sent_at) AS first_sent
        FROM contacts c JOIN sends s ON s.contact_id = c.id AND s.status <> 'failed'
       WHERE c.converted_at IS NULL
       GROUP BY c.id ORDER BY min(s.sent_at) DESC LIMIT 20000`);
    let found = 0, checked = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const res = await fetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
        method: "POST", headers: { Authorization: `Bearer ${cfg.hubspot.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ idProperty: "email", properties: ["email", "first_conversion_date", "recent_conversion_date", "recent_conversion_event_name", "first_conversion_event_name", "num_conversion_events"], inputs: chunk.map(r => ({ id: r.email })) }),
      });
      if (res.status === 429) { await sleep(10000); i -= 100; continue; }
      if (!res.ok && res.status !== 207) throw new Error(`batch read ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      checked += chunk.length;
      const byEmail = new Map(chunk.map(r => [r.email, r]));
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
      }
      await sleep(250);
    }
    convState.lastResult = `${checked} contacts checked, ${found} new conversion(s)`;
    await setSetting("conversions_last_run", new Date().toISOString());
    if (found) console.log(`[conversions] ${convState.lastResult}`);
  } catch (e) {
    convState.lastResult = `error: ${e.message}`;
    throw e;
  } finally { busy = false; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
