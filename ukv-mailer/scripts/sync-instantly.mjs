#!/usr/bin/env node
/**
 * One-off handover from Instantly:
 *   1. Every campaign  -> imported as a PAUSED campaign here (subject/body of each sequence step).
 *   2. Every lead      -> contact upserted; if Instantly already emailed them, instantly_contacted=true
 *                          (so enrolment skips them by default). Replied / unsubscribed / bounced
 *                          leads are suppressed so we never email them again.
 *
 * Env: INSTANTLY_API_KEY (auto-loaded from the sibling connector's .env), DATABASE_URL.
 *   node scripts/sync-instantly.mjs            # do it
 *   DRY_RUN=1 node scripts/sync-instantly.mjs  # just report
 */
import "./_env.mjs";
const KEY = process.env.INSTANTLY_API_KEY;
if (!KEY) { console.error("INSTANTLY_API_KEY missing"); process.exit(1); }
const DRY = process.env.DRY_RUN === "1";
const INST = "https://api.instantly.ai/api/v2";
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const { q, one, pool } = await import("../src/db.js");

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts?.method || "GET"} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function* paginate(path, body) {
  let starting_after;
  do {
    const b = body ? await jfetch(`${INST}${path}`, { method: "POST", headers: H, body: JSON.stringify({ ...body, limit: 100, starting_after }) })
                   : await jfetch(`${INST}${path}?limit=100${starting_after ? `&starting_after=${starting_after}` : ""}`, { headers: H });
    const items = b.items || b.data || [];
    for (const it of items) yield it;
    starting_after = b.next_starting_after || null;
    if (!items.length) break;
  } while (starting_after);
}

const siteFor = (name) => /chronicle/i.test(name) ? "investchronicles" : "marketwatcher";
const htmlToBody = (s) => String(s || "").replace(/\{\{\s*firstName\s*\}\}/gi, "{{first_name|there}}").replace(/\{\{\s*lastName\s*\}\}/gi, "{{last_name}}").replace(/\{\{\s*companyName\s*\}\}/gi, "{{company}}");

// ---- 1. campaigns + sequences ------------------------------------------------
const campaigns = [];
for await (const c of paginate("/campaigns")) campaigns.push(c);
console.log(`${campaigns.length} Instantly campaign(s)`);
for (const c of campaigns) {
  const steps = [];
  for (const seq of c.sequences || []) {
    for (const st of seq.steps || []) {
      const v = (st.variants || [])[0] || {};
      steps.push({ delay: Number(st.delay ?? st.delay_days ?? 0), subject: v.subject || "", body: v.body || "" });
    }
  }
  console.log(`  [${c.status}] ${c.name} (${c.id}) — ${steps.length} step(s)`);
  if (DRY) continue;
  const site = siteFor(c.name);
  const row = await one(`INSERT INTO campaigns(name,site,status,instantly_id) VALUES($1,$2,'paused',$3)
                         ON CONFLICT(instantly_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [`${c.name} (Instantly)`, site, c.id]);
  await q("DELETE FROM steps WHERE campaign_id=$1", [row.id]);
  steps.forEach(async (s, i) => {
    await q("INSERT INTO steps(campaign_id,position,delay_days,subject,body_html) VALUES($1,$2,$3,$4,$5)",
      [row.id, i + 1, i === 0 ? 0 : Math.max(1, s.delay), htmlToBody(s.subject), htmlToBody(s.body)]);
  });
}

// ---- 2. leads ----------------------------------------------------------------
const stat = { leads: 0, contacted: 0, suppressed: 0, inserted: 0 };
const nameOf = Object.fromEntries(campaigns.map(c => [c.id, c.name]));
for (const c of campaigns) {
  for await (const l of paginate("/leads/list", { campaign: c.id })) {
    stat.leads++;
    const email = String(l.email || "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    const sent = Number(l.email_sent_count ?? l.emails_sent ?? 0) > 0 || !!l.timestamp_last_contact || !!l.last_contacted_from;
    const replied = Number(l.email_reply_count ?? 0) > 0 || /replied|interested|meeting|closed/i.test(String(l.lt_interest_status ?? l.status ?? ""));
    const unsub = !!l.unsubscribed || /unsub/i.test(String(l.status || ""));
    const bounced = /bounce/i.test(String(l.status || l.esp_code || ""));
    const status = unsub ? "unsubscribed" : bounced ? "bounced" : replied ? "replied" : sent ? "contacted" : "not contacted";
    if (sent) stat.contacted++;
    if (DRY) continue;
    const r = await q(`INSERT INTO contacts(email,first_name,last_name,company,phone,data_source,source_file,site,instantly_contacted,instantly_status,instantly_campaign)
                       VALUES($1,$2,$3,$4,$5,$6,'instantly',$7,$8,$9,$10)
                       ON CONFLICT(email) DO UPDATE SET
                         first_name = COALESCE(NULLIF(contacts.first_name,''), EXCLUDED.first_name),
                         last_name  = COALESCE(NULLIF(contacts.last_name,''),  EXCLUDED.last_name),
                         phone      = COALESCE(NULLIF(contacts.phone,''),      EXCLUDED.phone),
                         instantly_contacted = contacts.instantly_contacted OR EXCLUDED.instantly_contacted,
                         instantly_status = EXCLUDED.instantly_status, instantly_campaign = EXCLUDED.instantly_campaign, updated_at=now()
                       RETURNING (xmax=0) AS inserted`,
      [email, l.first_name || "", l.last_name || "", l.company_name || "", l.phone || l.payload?.phone || "",
       /monaco/i.test(c.name) ? "LUSHA LEADS" : `Instantly: ${c.name}`, siteFor(c.name), sent, status, nameOf[c.id]]);
    if (r.rows[0]?.inserted) stat.inserted++;
    if (unsub || bounced || replied) {
      stat.suppressed++;
      await q("INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT DO NOTHING", [email, `instantly:${status}`]);
      await q("UPDATE contacts SET status=$2 WHERE email=$1 AND status='active'", [email, status]);
    }
  }
  console.log(`  leads so far: ${stat.leads} (contacted ${stat.contacted}, suppressed ${stat.suppressed})`);
}
console.log(`\nDone${DRY ? " (dry run)" : ""}: ${stat.leads} leads, ${stat.contacted} already contacted by Instantly, ${stat.suppressed} suppressed, ${stat.inserted} new contacts created`);
await pool.end();
