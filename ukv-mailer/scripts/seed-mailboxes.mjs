#!/usr/bin/env node
/**
 * Upsert mailboxes from a CSV: email,display_name,site[,smtp_pass]
 * Default file: data/mailboxes.csv (no passwords). Pass a Maildoso export that
 * includes passwords to set them in one go:  node scripts/seed-mailboxes.mjs path/to/export.csv
 * Existing passwords are kept when the CSV has none.
 *   --warmup         start the warm-up schedule today for every row in the CSV (5/10/20/30 per day by week)
 *   --site=<site>    force the site for every row (otherwise CSV `site` column, else guessed from the domain)
 *   --domain=<dom>   only process rows whose address is on this domain
 */
import "./_env.mjs";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

const args = process.argv.slice(2);
const flag = (k) => (args.find(a => a.startsWith(`--${k}=`)) || "").split("=")[1] || "";
const WARMUP = args.includes("--warmup"), SITE = flag("site"), DOMAIN = flag("domain").toLowerCase();
const file = args.find(a => !a.startsWith("--")) || new URL("../data/mailboxes.csv", import.meta.url);
const rows = parse(readFileSync(file, "utf8"), { columns: (h) => h.map(s => s.trim().toLowerCase().replace(/[\s-]+/g, "_")), skip_empty_lines: true, bom: true, trim: true });
const { q, pool } = await import("../src/db.js");

const siteFor = (email) => /investchronicles/i.test(email) ? "investchronicles" : "marketwatcher";
const nameFor = (email) => email.split("@")[0].split(".").map(s => s[0].toUpperCase() + s.slice(1)).join(" ");

let n = 0;
for (const r of rows) {
  const email = String(r.email || r.email_account || r.username || r.login || "").trim().toLowerCase();
  if (!email.includes("@")) continue;
  if (DOMAIN && email.split("@")[1] !== DOMAIN) continue;
  const pass = r.smtp_pass || r.smtp_password || r.password || r.imap_password || "";
  const name = r.display_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || r.name || nameFor(email);
  await q(`INSERT INTO mailboxes(email,display_name,domain,site,smtp_pass,warmup_from) VALUES($1,$2,$3,$4,NULLIF($5,''),$6)
           ON CONFLICT(email) DO UPDATE SET display_name = CASE WHEN EXCLUDED.display_name<>'' THEN EXCLUDED.display_name ELSE mailboxes.display_name END,
             site = EXCLUDED.site, smtp_pass = COALESCE(NULLIF(EXCLUDED.smtp_pass,''), mailboxes.smtp_pass),
             warmup_from = COALESCE(EXCLUDED.warmup_from, mailboxes.warmup_from), enabled = TRUE`,
    [email, name, email.split("@")[1], SITE || r.site || siteFor(email), pass, WARMUP ? new Date().toISOString().slice(0, 10) : null]);
  n++;
}
const stat = (await q("SELECT count(*)::int n, count(*) FILTER (WHERE smtp_pass IS NOT NULL AND smtp_pass<>'')::int with_pass FROM mailboxes")).rows[0];
console.log(`upserted ${n} mailboxes; ${stat.n} total, ${stat.with_pass} with a password`);
await pool.end();
