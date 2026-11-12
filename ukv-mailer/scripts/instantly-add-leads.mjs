#!/usr/bin/env node
/**
 * Upload reserved, verified, NON-Microsoft contacts to the Instantly Market Watcher campaign
 * (the Google pre-warmed mailboxes land in spam at Outlook, so Microsoft-hosted leads are never sent from them).
 *   node scripts/instantly-add-leads.mjs <count>          # dry run
 *   node scripts/instantly-add-leads.mjs <count> apply
 */
import "./_env.mjs";
const { q, all, pool } = await import("../src/db.js");
const N = Number(process.argv[2]) || 0, APPLY = process.argv[3] === "apply";
const KEY = process.env.INSTANTLY_REPORT_API_KEY, CAMP = "2cecb091-fd83-4b06-a647-a9fa1ee64637";
const rows = await all(`SELECT id, email, first_name, last_name, data_source, mail_provider FROM contacts
  WHERE instantly_status LIKE 'reserved: Instantly Market Watcher campaign%' AND instantly_sent_at IS NULL
    AND status='active' AND verify_result='ok' AND coalesce(mail_provider,'other') <> 'microsoft'
    AND NOT EXISTS (SELECT 1 FROM enrolments e WHERE e.contact_id=contacts.id)
  ORDER BY id LIMIT $1`, [N]);
const by = {}; for (const r of rows) by[`${r.data_source} / ${r.mail_provider}`] = (by[`${r.data_source} / ${r.mail_provider}`] || 0) + 1;
console.log(`selected ${rows.length}`, by);
if (!APPLY) { console.log("dry run - nothing uploaded"); await pool.end(); process.exit(0); }
let up = 0;
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  const r = await fetch("https://api.instantly.ai/api/v2/leads/add", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ campaign_id: CAMP, skip_if_in_workspace: true, leads: batch.map(c => ({ email: c.email, first_name: c.first_name || "", last_name: c.last_name || "" })) }) });
  const t = await r.text();
  if (!r.ok) { console.error(`batch ${i / 500 + 1} failed: ${r.status} ${t.slice(0, 300)}`); break; }
  const j = JSON.parse(t);
  console.log(`batch ${i / 500 + 1}:`, JSON.stringify({ uploaded: j.leads_uploaded, in_blocklist: j.in_blocklist, skipped: j.skipped_count, invalid: j.invalid_email_count, dup: j.duplicate_email_count, total_sent: j.total_sent }));
  await q(`UPDATE contacts SET instantly_sent_at=now(), instantly_status='uploaded: Instantly Market Watcher campaign (12 Nov 2026)' WHERE id = ANY($1)`, [batch.map(c => c.id)]);
  up += batch.length;
}
console.log(`marked ${up} contacts as uploaded`);
await pool.end();
