/**
 * Hold back AOL / Yahoo / Virgin.net contacts (17 Nov 2026).
 *
 * Instantly paused "Market Watcher - pre-warmed - Nov 2026" on bounce protection: 46 bounces from 919 sends.
 * Every bounced address had passed MillionVerifier as "ok", but those providers accept any address at
 * verification time and bounce dead accounts later. Bounce rates by provider: AOL 28%, Virgin.net 36%,
 * Yahoo 8%, Gmail 0%. So:
 *   1. Instantly: move the not-yet-contacted risky leads into a separate campaign that is never activated
 *   2. Mailer: stop active enrolments for risky contacts
 *   3. Mark every not-yet-emailed risky contact status='held', so they can't be enrolled
 *      (admin enrol needs status='active') or uploaded (instantly-add-leads.mjs needs status='active')
 *
 *   node scripts/hold-risky-domains.mjs          # dry run
 *   node scripts/hold-risky-domains.mjs apply    # do it
 */
import "./_env.mjs";
const { all, q, pool } = await import("../src/db.js");
const APPLY = process.argv[2] === "apply";
const KEY = process.env.INSTANTLY_REPORT_API_KEY;
const SRC = "2cecb091-fd83-4b06-a647-a9fa1ee64637";
const API = "https://api.instantly.ai/api/v2";
const HOLD_NAME = "Market Watcher - HOLD AOL Yahoo Virgin - Nov 2026 (do not activate)";
const REASON = "held: AOL/Yahoo/Virgin bounce risk (17 Nov 2026)";
const RISKY_SQL = String.raw`split_part(lower(email),'@',2) ~ '^(aol\.|yahoo\.|ymail\.|rocketmail\.|virgin\.net$)'`;
const risky = (e) => /@(aol\.|yahoo\.|ymail\.|rocketmail\.|virgin\.net$)/i.test(String(e).trim());

async function api(method, path, body) {
  for (;;) {
    const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 5000)); continue; }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
    return j;
  }
}

// ---- Instantly ----
const leads = []; let after;
for (;;) {
  const page = await api("POST", "/leads/list", { campaign: SRC, limit: 100, ...(after ? { starting_after: after } : {}) });
  leads.push(...page.items);
  if (!page.next_starting_after || !page.items.length) break;
  after = page.next_starting_after;
}
const contacted = (l) => !!(l.timestamp_last_contact || l.email_reply_count || (l.status && l.status !== 1));
const instContacted = new Set(leads.filter(contacted).map(l => l.email.toLowerCase()));
const toMove = leads.filter(l => risky(l.email) && !contacted(l));
console.log(`Instantly: ${leads.length} leads, ${toMove.length} risky not yet contacted -> move to hold campaign`);

// ---- Mailer ----
const enr = await all(`SELECT count(*)::int n FROM enrolments e JOIN contacts c ON c.id=e.contact_id WHERE e.status='active' AND ${RISKY_SQL.replace(/email/g, "c.email")}`);
const held = await all(`SELECT c.id, lower(c.email) email FROM contacts c WHERE c.status='active' AND ${RISKY_SQL.replace(/email/g, "c.email")}
  AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.contact_id=c.id AND s.status<>'failed')`);
const holdIds = held.filter(r => !instContacted.has(r.email)).map(r => r.id);
console.log(`Mailer: ${enr[0].n} active enrolments to stop; ${holdIds.length} not-yet-emailed contacts to mark held`);

if (!APPLY) { console.log("dry run - nothing changed"); await pool.end(); process.exit(0); }

const src = await api("GET", `/campaigns/${SRC}`);
const copy = ["campaign_schedule", "text_only", "first_email_text_only", "daily_limit", "stop_on_reply", "link_tracking", "open_tracking", "stop_on_auto_reply", "insert_unsubscribe_header"];
const existing = (await api("GET", `/campaigns?limit=100&search=${encodeURIComponent("HOLD AOL")}`)).items?.find(c => c.name === HOLD_NAME);
let dst = existing;
if (!dst) {
  const body = { name: HOLD_NAME, sequences: src.sequences, email_list: [] };   // no sending accounts: it cannot send even if activated
  for (const k of copy) if (src[k] !== undefined && src[k] !== null) body[k] = src[k];
  dst = await api("POST", "/campaigns", body);
}
console.log(`hold campaign ${existing ? "exists" : "created"}: ${dst.id} (status ${dst.status})`);

for (let i = 0; i < toMove.length; i += 500) {
  const job = await api("POST", "/leads/move", { ids: toMove.slice(i, i + 500).map(l => l.id), campaign: SRC, to_campaign_id: dst.id });
  console.log(`move job ${i / 500 + 1}:`, job.id || job.status || JSON.stringify(job).slice(0, 120));
  for (let t = 0; t < 120 && job.id; t++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await api("GET", `/background-jobs/${job.id}`).catch(e => ({ status: "unknown: " + e.message.slice(0, 80) }));
    if (/success|completed|failed|error/i.test(st.status || "")) { console.log("  ->", st.status); break; }
  }
}

const moved = toMove.map(l => l.email.toLowerCase());
const r1 = await q("UPDATE contacts SET instantly_status=$2, updated_at=now() WHERE lower(email) = ANY($1)", [moved, `held: Instantly hold campaign (17 Nov 2026)`]);
const r2 = await q(`UPDATE enrolments e SET status='stopped', stop_reason=$1 FROM contacts c WHERE c.id=e.contact_id AND e.status='active' AND ${RISKY_SQL.replace(/email/g, "c.email")}`, [REASON]);
const r3 = await q("UPDATE contacts SET status='held', updated_at=now() WHERE id = ANY($1) AND status='active'", [holdIds]);
console.log(`done: ${r1.rowCount} contacts relabelled as Instantly-held, ${r2.rowCount} enrolments stopped, ${r3.rowCount} contacts marked held`);
await pool.end();
