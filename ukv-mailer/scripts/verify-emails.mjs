// Bulk email verification through MillionVerifier (https://developer.millionverifier.com).
//
//   node scripts/verify-emails.mjs upload [--limit=100000] [--source="GM CLEAN"] [--site=investchronicles] [--recheck-days=180]
//   node scripts/verify-emails.mjs status                      # progress of every job not yet imported
//   node scripts/verify-emails.mjs import [file_id]            # pull results into contacts (all finished jobs if no id)
//   node scripts/verify-emails.mjs run [upload flags]          # upload, wait, import
//
// Needs MILLIONVERIFIER_KEY in .env / Render env. Credits: one per unique email uploaded.
// Results land in contacts.verify_result / verify_quality / verified_at. Enrolment in the admin
// UI defaults to verify_result='ok'; invalid/disposable addresses are marked status='bounced'
// and any active enrolment is stopped, so they are never sent to.
import "./_env.mjs";
import { q, all, pool } from "../src/db.js";
import { parse } from "csv-parse/sync";

const BASE = "https://bulkapi.millionverifier.com/bulkapi/v2";
const KEY = process.env.MILLIONVERIFIER_KEY;
const CHUNK = 50000;                       // emails per upload (keeps each file manageable)
const args = process.argv.slice(2);
const cmd = args[0] || "status";
const opt = Object.fromEntries(args.slice(1).filter(a => a.startsWith("--")).map(a => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }));
const positional = args.slice(1).filter(a => !a.startsWith("--"));

if (!KEY && cmd !== "status") { console.error("MILLIONVERIFIER_KEY is not set"); process.exit(1); }

async function api(path, params, init) {
  const u = new URL(`${BASE}/${path}`); u.searchParams.set("key", KEY);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const r = await fetch(u, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function upload() {
  const where = ["status='active'", "NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=contacts.email)"];
  const params = [];
  if (opt.source) { params.push(opt.source); where.push(`data_source=$${params.length}`); }
  if (opt.site) { params.push(opt.site); where.push(`site=$${params.length}`); }
  const recheck = Math.max(0, Number(opt["recheck-days"] || 0));
  where.push(recheck > 0 ? `(verified_at IS NULL OR verified_at < now() - interval '${recheck} days')` : "verified_at IS NULL");
  // Skip anything already sitting in an un-imported job.
  await q("CREATE TEMP TABLE verify_pending(email TEXT)");
  for (const j of await all("SELECT summary FROM verify_jobs WHERE status<>'imported'")) {
    const emails = j.summary?.emails || [];
    if (emails.length) await q("INSERT INTO verify_pending SELECT unnest($1::text[])", [emails]);
  }
  where.push("NOT EXISTS (SELECT 1 FROM verify_pending p WHERE p.email=contacts.email)");
  const limit = Math.max(1, Number(opt.limit || 100000));
  const rows = await all(`SELECT email FROM contacts WHERE ${where.join(" AND ")} ORDER BY instantly_contacted, id LIMIT ${limit}`, params);
  if (!rows.length) { console.log("nothing to verify"); return []; }
  console.log(`${rows.length} contacts to verify`);
  const ids = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const emails = rows.slice(i, i + CHUNK).map(r => r.email);
    const name = `ukv-${new Date().toISOString().slice(0, 10)}-${Math.floor(i / CHUNK) + 1}.txt`;
    const form = new FormData();
    form.append("file_contents", new Blob([emails.join("\n")], { type: "text/plain" }), name);
    const info = await (await api("upload", {}, { method: "POST", body: form })).json();
    if (info.error) throw new Error(`upload: ${info.error}`);
    await q("INSERT INTO verify_jobs(file_id,file_name,emails,status,summary) VALUES($1,$2,$3,$4,$5)",
      [String(info.file_id), name, emails.length, info.status || "in_progress", JSON.stringify({ emails, uploaded: info })]);
    console.log(`uploaded ${name}: file_id ${info.file_id}, ${info.unique_emails ?? emails.length} unique, est ${info.estimated_time_sec ?? "?"}s`);
    ids.push(String(info.file_id));
  }
  return ids;
}

const info = async fileId => (await api("fileinfo", { file_id: fileId })).json();

async function status() {
  const jobs = await all("SELECT file_id, file_name, emails, status, created_at FROM verify_jobs WHERE status<>'imported' ORDER BY created_at");
  if (!jobs.length) { console.log("no pending verification jobs"); return []; }
  const out = [];
  for (const j of jobs) {
    const i = KEY ? await info(j.file_id) : {};
    console.log(`${j.file_id}  ${j.file_name}  ${i.status || j.status}  ${i.percent ?? "?"}%  ok=${i.ok ?? "?"} catch_all=${i.catch_all ?? "?"} unknown=${i.unknown ?? "?"} invalid=${i.invalid ?? "?"} disposable=${i.disposable ?? "?"}`);
    if (i.status && i.status !== j.status) await q("UPDATE verify_jobs SET status=$2 WHERE file_id=$1", [j.file_id, i.status]);
    out.push({ ...j, ...i });
  }
  return out;
}

const pick = (hdr, ...names) => hdr.findIndex(h => names.includes(h));
async function importJob(fileId) {
  const csv = await (await api("download", { file_id: fileId, filter: "all" })).text();
  if (csv.trim().startsWith("{")) throw new Error(`download ${fileId}: ${csv.slice(0, 200)}`);
  const rows = parse(csv, { relax_column_count: true, skip_empty_lines: true, bom: true });
  const hdr = rows[0].map(h => String(h).trim().toLowerCase());
  const ci = { email: pick(hdr, "email", "e-mail", "emails"), result: pick(hdr, "result"), quality: pick(hdr, "quality") };
  if (ci.email < 0 || ci.result < 0) throw new Error(`download ${fileId}: unexpected columns ${hdr.join(",")}`);
  const counts = {};
  const batch = [];
  for (const r of rows.slice(1)) {
    const email = String(r[ci.email] || "").trim().toLowerCase();
    const result = String(r[ci.result] || "").trim().toLowerCase();
    if (!email || !result) continue;
    counts[result] = (counts[result] || 0) + 1;
    batch.push([email, result, ci.quality >= 0 ? String(r[ci.quality] || "").trim().toLowerCase() : null]);
  }
  const client = await pool.connect();
  let dead = { rowCount: 0, rows: [] };
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE vr(email TEXT, result TEXT, quality TEXT) ON COMMIT DROP");
    for (let i = 0; i < batch.length; i += 5000) {
      const slice = batch.slice(i, i + 5000);
      await client.query("INSERT INTO vr SELECT * FROM unnest($1::text[], $2::text[], $3::text[])",
        [slice.map(b => b[0]), slice.map(b => b[1]), slice.map(b => b[2])]);
    }
    await client.query(`UPDATE contacts c SET verify_result=vr.result, verify_quality=vr.quality, verified_at=now(), updated_at=now()
                        FROM vr WHERE lower(c.email)=vr.email`);
    // Invalid / disposable: never send. Mark bounced and stop any queued enrolment.
    dead = await client.query(`UPDATE contacts c SET status='bounced', updated_at=now() FROM vr
                        WHERE lower(c.email)=vr.email AND vr.result IN ('invalid','disposable') AND c.status='active' RETURNING c.id`);
    if (dead.rowCount) await client.query(`UPDATE enrolments SET status='stopped', stop_reason='invalid_email'
                        WHERE status='active' AND contact_id = ANY($1::int[])`, [dead.rows.map(r => r.id)]);
    await client.query("UPDATE verify_jobs SET status='imported', imported_at=now(), summary = (summary - 'emails') || $2::jsonb WHERE file_id=$1",
      [fileId, JSON.stringify({ counts, rows: batch.length })]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  console.log(`imported ${fileId}: ${batch.length} rows`, counts, dead.rowCount ? `(${dead.rowCount} marked bounced)` : "");
}

async function importAll(ids) {
  const jobs = ids?.length ? ids : (await status()).filter(j => j.status === "finished").map(j => j.file_id);
  for (const id of jobs) await importJob(id);
  if (!jobs.length) console.log("no finished jobs to import");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  if (cmd === "upload") await upload();
  else if (cmd === "status") await status();
  else if (cmd === "import") await importAll(positional);
  else if (cmd === "run") {
    const ids = await upload();
    if (ids.length) {
      for (;;) {
        await sleep(60000);
        const st = await Promise.all(ids.map(info));
        console.log(st.map(s => `${s.file_id}:${s.status}:${s.percent}%`).join("  "));
        if (st.every(s => s.status === "finished")) break;
        if (st.some(s => s.status === "error" || s.error)) throw new Error("a job errored: " + JSON.stringify(st));
      }
      await importAll(ids);
    }
  } else { console.error("usage: verify-emails.mjs upload|status|import|run"); process.exit(1); }
} finally { await pool.end(); }
