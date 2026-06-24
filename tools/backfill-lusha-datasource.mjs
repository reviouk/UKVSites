#!/usr/bin/env node
/**
 * One-shot backfill for the "Market watcher Monaco Data" Instantly campaign
 * (id 313af329-7220-42a7-a94a-470f8d526224) — a list of Lusha-sourced leads.
 *
 * For every HubSpot contact that already exists for one of this campaign's
 * leads, set:
 *   data_source           = "LUSHA LEADS"   (free-text property, always filled)
 *   external_lead_source  = "Marketwatcher" (LEAD SOURCE — only when blank)
 *
 * It NEVER creates contacts — only updates ones the webhook already created on
 * engagement — and never overwrites a lead source a human already set.
 *
 * Creds: auto-loads the sibling UKV-Instantly-Hubspot .env (HUBSPOT_TOKEN,
 * INSTANTLY_API_KEY). Run with DRY_RUN=1 to preview.
 * TLS-intercepted machine: NODE_TLS_REJECT_UNAUTHORIZED forced to 0.
 */
import { readFileSync } from "node:fs";
(() => {
  const envPath = "C:/VISUAL STUDIO CODEX/UKV Instantly Hubspot/.env";
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* fall back to ambient env */ }
})();
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const CAMPAIGN_ID       = process.env.CAMPAIGN_ID || "313af329-7220-42a7-a94a-470f8d526224";
const DATA_SOURCE       = process.env.DATA_SOURCE || "LUSHA LEADS";
const LEAD_SOURCE       = process.env.LEAD_SOURCE || "Marketwatcher";
const DRY_RUN           = process.env.DRY_RUN === "1";

const HS   = "https://api.hubapi.com";
const INST = "https://api.instantly.ai/api/v2";

function need(n, v) { if (!v) { console.error(`Missing required env var: ${n}`); process.exit(1); } }
need("INSTANTLY_API_KEY", INSTANTLY_API_KEY);
need("HUBSPOT_TOKEN", HUBSPOT_TOKEN);

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  // 207 = multi-status (batch read with some missing ids) — still usable
  if (!res.ok && res.status !== 207) throw new Error(`${opts?.method || "GET"} ${url} -> ${res.status}: ${text}`);
  return body;
}

/** All lead emails in this Instantly campaign. */
async function fetchCampaignEmails() {
  const emails = new Set();
  let starting_after;
  do {
    const body = await jfetch(`${INST}/leads/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ campaign: CAMPAIGN_ID, limit: 100, starting_after }),
    });
    const items = body.items || body.data || [];
    for (const l of items) {
      const e = (l.email || "").trim().toLowerCase();
      if (e) emails.add(e);
    }
    starting_after = body.next_starting_after || body.starting_after || null;
    if (!items.length) break;
  } while (starting_after);
  return [...emails];
}

/** Batch-read existing HubSpot contacts by email; returns Map(email -> {id, props}). */
async function fetchExisting(emails) {
  const found = new Map();
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const body = await jfetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        idProperty: "email",
        properties: ["email", "data_source", "external_lead_source"],
        inputs: chunk.map(id => ({ id })),
      }),
    });
    for (const r of body.results || []) {
      const email = (r.properties?.email || "").trim().toLowerCase();
      if (email) found.set(email, { id: r.id, p: r.properties });
    }
  }
  return found;
}

async function batchUpdate(updates) {
  for (let i = 0; i < updates.length; i += 100) {
    const inputs = updates.slice(i, i + 100);
    await jfetch(`${HS}/crm/v3/objects/contacts/batch/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    });
    console.log(`  updated ${inputs.length} contacts`);
  }
}

(async () => {
  console.log(`Lusha backfill: campaign ${CAMPAIGN_ID} -> data_source="${DATA_SOURCE}", lead source="${LEAD_SOURCE}"`);
  const emails = await fetchCampaignEmails();
  console.log(`  ${emails.length} lead email(s) in the campaign`);
  const existing = await fetchExisting(emails);
  console.log(`  ${existing.size} of them already exist as HubSpot contacts`);

  const updates = [];
  const stat = { data_source: 0, lead_source: 0 };
  for (const { id, p } of existing.values()) {
    const props = {};
    if (p.data_source !== DATA_SOURCE) { props.data_source = DATA_SOURCE; stat.data_source++; }
    if (!p.external_lead_source) { props.external_lead_source = LEAD_SOURCE; stat.lead_source++; }
    if (Object.keys(props).length) updates.push({ id, properties: props });
  }
  console.log(`  fills -> data_source:${stat.data_source} lead_source:${stat.lead_source}; ${updates.length} contact(s) to update`);

  if (DRY_RUN) {
    updates.slice(0, 20).forEach(u => console.log("   ", u.id, JSON.stringify(u.properties)));
    if (updates.length > 20) console.log(`    ... and ${updates.length - 20} more`);
    console.log("DRY_RUN — nothing written.");
    return;
  }
  if (updates.length) await batchUpdate(updates);
  else console.log("Nothing to update.");
  console.log("Done.");
})().catch(e => { console.error(e); process.exit(1); });
