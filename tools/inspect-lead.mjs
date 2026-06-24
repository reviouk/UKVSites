#!/usr/bin/env node
/**
 * Dump the raw Instantly lead object(s) so we can see the real field names.
 *
 *   INSTANTLY_API_KEY=... node tools/inspect-lead.mjs peterdownes69@yahoo.co.uk
 *
 * If you pass no email, it prints the first lead in the campaign.
 */
const KEY = process.env.INSTANTLY_API_KEY;
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || "ce0cf494-ddd6-4337-bd2a-34188168c32e";
const TARGET = (process.argv[2] || "").trim().toLowerCase();
const BASE = "https://api.instantly.ai/api/v2";

if (!KEY) { console.error("Missing INSTANTLY_API_KEY"); process.exit(1); }

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

(async () => {
  let starting_after, found = null, first = null, total = 0;
  do {
    const body = await jfetch(`${BASE}/leads/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ campaign: CAMPAIGN_ID, limit: 100, starting_after }),
    });
    const items = body.items || body.data || [];
    total += items.length;
    if (!first && items.length) first = items[0];
    if (TARGET) found = items.find(l => (l.email || "").trim().toLowerCase() === TARGET);
    starting_after = body.next_starting_after || body.starting_after || null;
    if (found || !items.length) break;
  } while (starting_after);

  const lead = TARGET ? found : first;
  if (!lead) { console.log(`No lead found for "${TARGET}" (scanned ${total}).`); return; }
  console.log(`Scanned ${total} leads. Raw object for ${lead.email}:\n`);
  console.log(JSON.stringify(lead, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
