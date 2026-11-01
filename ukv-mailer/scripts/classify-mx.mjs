// Tag every contact with the mail provider behind their domain's MX record.
//
//   node scripts/classify-mx.mjs            # classify contacts not yet checked
//   node scripts/classify-mx.mjs --recheck  # re-resolve every domain (cache ignored)
//
// Results: contacts.mail_provider / mx_host / mx_checked_at, cached per domain in mx_cache.
// Providers: microsoft | google | yahoo | apple | gateway | other | none (no MX / NXDOMAIN).
import "./_env.mjs";
import { Resolver } from "node:dns/promises";
import { q, all, pool } from "../src/db.js";
import { providerForMx } from "../src/routing.js";

const recheck = process.argv.includes("--recheck");
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["8.8.8.8", "1.1.1.1"]);
const CONCURRENCY = 40;

async function lookup(domain) {
  try {
    const mx = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    const host = mx[0]?.exchange?.toLowerCase().replace(/\.$/, "") || "";
    return { mx_host: host || null, provider: providerForMx(host) };
  } catch (e) {
    if (/ENOTFOUND|ENODATA|NXDOMAIN|ESERVFAIL|EREFUSED/.test(e.code || e.message)) {
      // No MX: RFC 5321 falls back to an A record, but for a cold list that is a dead domain in practice.
      try { await resolver.resolve4(domain); return { mx_host: null, provider: "other" }; } catch { return { mx_host: null, provider: "none" }; }
    }
    return { mx_host: null, provider: "unknown", error: e.code || e.message };
  }
}

const where = recheck ? "" : "AND mx_checked_at IS NULL";
const domains = (await all(`SELECT DISTINCT lower(split_part(email,'@',2)) AS d FROM contacts WHERE status='active' ${where}`)).map(r => r.d).filter(Boolean);
console.log(`${domains.length} domains to classify`);

const cached = recheck ? new Set() : new Set((await all("SELECT domain FROM mx_cache")).map(r => r.domain));
const todo = domains.filter(d => !cached.has(d));
console.log(`${todo.length} not in cache; resolving with ${CONCURRENCY} workers`);

let done = 0, errors = 0;
const results = [];
async function worker() {
  for (;;) {
    const d = todo.shift();
    if (!d) return;
    const r = await lookup(d);
    if (r.provider === "unknown") { errors++; continue; }           // transient: leave for the next run
    results.push([d, r.mx_host, r.provider]);
    if (++done % 2000 === 0) console.log(`  ${done}/${done + todo.length} resolved`);
    if (results.length >= 1000) await flush();
  }
}
async function flush() {
  const b = results.splice(0);
  if (!b.length) return;
  await q(`INSERT INTO mx_cache(domain, mx_host, provider, checked_at) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], array_fill(now(), ARRAY[$4::int]))
           ON CONFLICT (domain) DO UPDATE SET mx_host=EXCLUDED.mx_host, provider=EXCLUDED.provider, checked_at=EXCLUDED.checked_at`,
    [b.map(x => x[0]), b.map(x => x[1]), b.map(x => x[2]), b.length]);
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await flush();
console.log(`resolved ${done}, transient errors ${errors}`);

const upd = await q(`UPDATE contacts c SET mail_provider=m.provider, mx_host=m.mx_host, mx_checked_at=m.checked_at, updated_at=now()
                     FROM mx_cache m WHERE m.domain = lower(split_part(c.email,'@',2)) ${recheck ? "" : "AND c.mx_checked_at IS NULL"}`);
console.log(`updated ${upd.rowCount} contacts`);
for (const r of await all("SELECT COALESCE(mail_provider,'unclassified') AS provider, count(*)::int AS n FROM contacts WHERE status='active' GROUP BY 1 ORDER BY 2 DESC"))
  console.log(`  ${r.provider.padEnd(13)} ${r.n}`);
await pool.end();
