#!/usr/bin/env node
/**
 * Instantly (Market Watcher): switch the pre-warmed campaign to ONE email with variants A/B/C
 * (Mike's emails 1/2/3, existing Market Watcher-branded bodies), create a Dubai campaign with the
 * same settings, and move the not-yet-contacted Dubai Microsoft leads into it so they send first.
 *
 *   node scripts/instantly-single-email.mjs            # dry run: shows what would change
 *   node scripts/instantly-single-email.mjs apply      # do it
 * Backup of the original campaign: import/instantly-campaign-2cecb-backup-2026-11-12.json
 */
import "./_env.mjs";
const { all, pool } = await import("../src/db.js");
const APPLY = process.argv[2] === "apply";
const KEY = process.env.INSTANTLY_REPORT_API_KEY;
const SRC = "2cecb091-fd83-4b06-a647-a9fa1ee64637";
const API = "https://api.instantly.ai/api/v2";
const DUBAI_NAME = "Market Watcher - Dubai - single email - Nov 2026";

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}

const src = await api("GET", `/campaigns/${SRC}`);
const { readFileSync } = await import("node:fs");
const orig = JSON.parse(readFileSync(new URL("../import/instantly-campaign-2cecb-backup-2026-11-12.json", import.meta.url), "utf8"));
const [s1, s2, s3] = orig.sequences[0].steps;          // original 3-step copy (campaign may already be switched)
const SUBJECT_B = "What the US tariff decision means for casks";
const SUBJECT_C = "How rare whisky has performed over ten years";
const single = [{ steps: [{ type: "email", delay: s1.delay, variants: [
  { subject: s1.variants[0].subject, body: s1.variants[0].body },
  { subject: SUBJECT_B, body: s2.variants[0].body },
  { subject: SUBJECT_C, body: s3.variants[0].body },
] }] }];
for (const v of single[0].steps[0].variants)
  if (!/marketwatcher\.co\.uk/.test(v.body) || /investchronicle/i.test(v.body)) throw new Error("branding check failed for " + v.subject);
console.log("single-email variants:", single[0].steps[0].variants.map(v => v.subject));

// Dubai Microsoft contacts we uploaded on 11 Nov
const dubai = new Set((await all("SELECT lower(email) e FROM contacts WHERE data_source='DUBAI 091126' AND instantly_contacted")).map(r => r.e));
const leads = []; let after;
for (;;) {
  const page = await api("POST", "/leads/list", { campaign: SRC, limit: 100, ...(after ? { starting_after: after } : {}) });
  leads.push(...page.items);
  if (!page.next_starting_after || !page.items.length) break;
  after = page.next_starting_after;
}
const contacted = (l) => !!(l.timestamp_last_contact || l.email_reply_count || (l.status && l.status !== 1));
const toMove = leads.filter(l => dubai.has(String(l.email).toLowerCase()) && !contacted(l));
console.log(`campaign leads ${leads.length}; Dubai in campaign ${leads.filter(l => dubai.has(String(l.email).toLowerCase())).length}; Dubai not yet contacted (to move) ${toMove.length}`);
console.log("sample lead fields:", Object.keys(leads[0] || {}).join(","));

if (!APPLY) { console.log("dry run - nothing changed"); await pool.end(); process.exit(0); }

await api("PATCH", `/campaigns/${SRC}`, { sequences: single });
console.log("original campaign now single email A/B/C");

const copy = ["campaign_schedule", "text_only", "first_email_text_only", "email_list", "daily_limit", "stop_on_reply", "email_tag_list", "link_tracking", "open_tracking", "stop_on_auto_reply", "prioritize_new_leads", "match_lead_esp", "stop_for_company", "insert_unsubscribe_header", "allow_risky_contacts", "disable_bounce_protect"];
const body = { name: DUBAI_NAME, sequences: single };
for (const k of copy) if (src[k] !== undefined && src[k] !== null) body[k] = src[k];
body.campaign_schedule = { ...src.campaign_schedule, start_date: new Date().toISOString().slice(0, 10) };
const existing = (await api("GET", `/campaigns?limit=100&search=${encodeURIComponent(DUBAI_NAME)}`)).items?.find(c => c.name === DUBAI_NAME);
const dst = existing || await api("POST", "/campaigns", body);
console.log(`Dubai campaign ${existing ? "exists" : "created"}: ${dst.id}`);

for (let i = 0; i < toMove.length; i += 500) {
  const job = await api("POST", "/leads/move", { ids: toMove.slice(i, i + 500).map(l => l.id), campaign: SRC, to_campaign_id: dst.id });
  console.log(`move job ${i / 500 + 1}:`, job.id || job.status || JSON.stringify(job).slice(0, 120));
  for (let t = 0; t < 120 && job.id; t++) {          // one move job per campaign at a time
    await new Promise(r => setTimeout(r, 5000));
    const st = await api("GET", `/background-jobs/${job.id}`).catch(e => ({ status: "unknown: " + e.message.slice(0, 80) }));
    if (/success|completed|failed|error/i.test(st.status || "")) { console.log("  ->", st.status); break; }
  }
}
console.log("done - activate the Dubai campaign once the move jobs finish");
await pool.end();
