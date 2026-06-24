#!/usr/bin/env node
/**
 * Enrich the HubSpot "open" list (Instantly openers) with the fields that the
 * original opener import didn't backfill: first/last name, phone, and LEAD
 * SOURCE. Pulls the truth from the Instantly campaign and only ever FILLS
 * BLANKS in HubSpot — it never overwrites a value a human already set.
 *
 *   name           <- Instantly first_name / last_name
 *   phone          <- Instantly `phone` (normalised to UK format, leading 0)
 *   external_lead_source ("LEAD SOURCE")  <- LEAD_SOURCE (campaign label)
 *
 * Required env:
 *   INSTANTLY_API_KEY, HUBSPOT_TOKEN
 * Optional:
 *   CAMPAIGN_ID   default = techmarketwatcher.org / "Marketwatcher" campaign
 *   LEAD_SOURCE   default "Marketwatcher" (the external_lead_source value)
 *   DRY_RUN=1     preview only
 *
 * TLS-intercepted machine: run with NODE_TLS_REJECT_UNAUTHORIZED=0.
 */

// --- Self-contained creds: load the sibling .env so a scheduler needs no
// secrets in its task definition. Explicit env vars still win. ---
import { readFileSync } from "node:fs";
(() => {
  const envPath = "C:\\VISUAL STUDIO CODEX\\UKV Instantly Hubspot\\.env";
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* fall back to whatever is already in the environment */ }
})();
// This machine has TLS interception; node fetch needs cert checks off.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;
const CAMPAIGN_ID       = process.env.CAMPAIGN_ID || "ce0cf494-ddd6-4337-bd2a-34188168c32e";
const LEAD_SOURCE       = process.env.LEAD_SOURCE || "Marketwatcher";
const DRY_RUN           = process.env.DRY_RUN === "1";

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const HUBSPOT_BASE   = "https://api.hubapi.com";

function need(n, v) { if (!v) { console.error(`Missing required env var: ${n}`); process.exit(1); } }
need("INSTANTLY_API_KEY", INSTANTLY_API_KEY);
if (!DRY_RUN) need("HUBSPOT_TOKEN", HUBSPOT_TOKEN);

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error(`${opts?.method || "GET"} ${url} -> ${res.status}: ${text}`);
  return body;
}

/** Normalise a raw Instantly phone string into a UK-style number, or "" if junk. */
function normPhone(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("0044")) d = d.slice(4);
  else if (d.startsWith("44") && d.length >= 12) d = d.slice(2);
  if (d.length === 10) d = "0" + d;                 // leading 0 was stripped on upload
  if (d.length !== 11 || d[0] !== "0") return "";   // not a plausible UK number -> skip
  return d;
}

/** email -> {firstname,lastname,phone} from the whole Instantly campaign. */
async function fetchInstantlyMap() {
  const map = new Map();
  let starting_after;
  do {
    const body = await jfetch(`${INSTANTLY_BASE}/leads/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ campaign: CAMPAIGN_ID, limit: 100, starting_after }),
    });
    const items = body.items || body.data || [];
    for (const l of items) {
      const email = (l.email || "").trim().toLowerCase();
      if (!email || map.has(email)) continue;
      map.set(email, {
        firstname: (l.first_name || l.firstName || "").trim(),
        lastname:  (l.last_name  || l.lastName  || "").trim(),
        phone:     normPhone(l.phone || l.payload?.phone),
      });
    }
    starting_after = body.next_starting_after || body.starting_after || null;
    if (!items.length) break;
  } while (starting_after);
  return map;
}

/** All HubSpot contacts in the open list (instantly_opened=true). */
async function fetchOpeners() {
  const out = [];
  let after;
  do {
    const body = await jfetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "instantly_opened", operator: "EQ", value: "true" }] }],
        properties: ["email", "firstname", "lastname", "phone", "external_lead_source", "instantly_campaign"],
        limit: 100,
        after,
      }),
    });
    out.push(...(body.results || []));
    after = body.paging?.next?.after;
  } while (after);
  return out;
}

async function batchUpdate(updates) {
  for (let i = 0; i < updates.length; i += 100) {
    const inputs = updates.slice(i, i + 100);
    await jfetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    });
    console.log(`  updated ${inputs.length} contacts`);
  }
}

(async () => {
  console.log(`Instantly campaign ${CAMPAIGN_ID} -> HubSpot open list enrichment`);
  const inst = await fetchInstantlyMap();
  console.log(`  ${inst.size} Instantly leads indexed by email`);
  const openers = await fetchOpeners();
  console.log(`  ${openers.length} HubSpot openers (instantly_opened=true)`);

  const updates = [];
  const gaps = [];
  const stat = { firstname: 0, lastname: 0, phone: 0, lead_source: 0, noInstantly: 0 };
  for (const c of openers) {
    const p = c.properties;
    const email = (p.email || "").trim().toLowerCase();
    const src = inst.get(email);
    const props = {};
    // Lead source: campaign label, only when blank and this is the right campaign.
    if (!p.external_lead_source && (!p.instantly_campaign || p.instantly_campaign === CAMPAIGN_ID)) {
      props.external_lead_source = LEAD_SOURCE; stat.lead_source++;
    }
    if (src) {
      if (!p.firstname && src.firstname) { props.firstname = src.firstname; stat.firstname++; }
      if (!p.lastname  && src.lastname)  { props.lastname  = src.lastname;  stat.lastname++; }
      if (!p.phone     && src.phone)     { props.phone     = src.phone;     stat.phone++; }
    } else {
      stat.noInstantly++;
    }
    if (Object.keys(props).length) updates.push({ id: c.id, properties: props });

    // What's still missing AFTER this run's fills? (the hourly "check")
    const final = { ...p, ...props };
    const missing = ["firstname", "email", "phone", "external_lead_source"]
      .filter(f => !final[f]);
    if (missing.length) gaps.push({ id: c.id, email: p.email, missing });
  }

  console.log(`  fills -> firstname:${stat.firstname} lastname:${stat.lastname} phone:${stat.phone} lead_source:${stat.lead_source}`);
  console.log(`  ${updates.length} contacts need an update; ${stat.noInstantly} openers had no Instantly match`);

  if (DRY_RUN) {
    updates.slice(0, 20).forEach(u => console.log("   ", u.id, JSON.stringify(u.properties)));
    if (updates.length > 20) console.log(`    ... and ${updates.length - 20} more`);
    console.log("DRY_RUN — nothing written.");
    return;
  }
  if (updates.length) await batchUpdate(updates);
  else console.log("Nothing to update.");

  if (gaps.length) {
    console.log(`\n[CHECK] ${gaps.length} opener(s) still missing fields (no Instantly source for them):`);
    gaps.forEach(g => console.log(`   ${g.email}  ->  missing: ${g.missing.join(", ")}`));
  } else {
    console.log("\n[CHECK] All openers have name, email, phone and lead source. ✓");
  }
  console.log("Done.");
})().catch(e => { console.error(e); process.exit(1); });
