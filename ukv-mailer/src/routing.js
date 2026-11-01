/**
 * Recipient mail-provider classification and per-provider routing to mailbox pools.
 *
 * Why: Microsoft 365 / Outlook.com junk everything sent through Maildoso's shared relay
 * (SFV:SPM, PTR:InfoDomainNonexistent, in-addr.arpa HELO), while Gmail and independent
 * gateways accept it. So each contact is tagged with the provider behind their domain's
 * MX record and the sender picks a mailbox from the pool configured for that provider.
 * A provider routed to "hold" is simply not sent to until a pool is assigned.
 */
import { getSetting, all } from "./db.js";

export const PROVIDERS = ["microsoft", "google", "yahoo", "apple", "gateway", "other", "none"];
export const HOLD = "hold";
const DEFAULT_ROUTE = { microsoft: HOLD };   // everything else -> the default pool

/** Classify an MX hostname (lowercase) into a provider bucket. */
export function providerForMx(mx) {
  const h = String(mx || "").toLowerCase().replace(/\.$/, "");
  if (!h) return "none";
  if (/(^|\.)(mail\.protection\.outlook\.com|outlook\.com|hotmail\.com|olc\.protection\.outlook\.com|eo\.outlook\.com)$/.test(h)) return "microsoft";
  if (/(^|\.)(google\.com|googlemail\.com|gmail\.com|googlehosted\.com)$/.test(h)) return "google";
  if (/(^|\.)(yahoodns\.net|yahoo\.com|aol\.com|verizonmedia\.com)$/.test(h)) return "yahoo";
  if (/(^|\.)(icloud\.com|me\.com|apple\.com)$/.test(h)) return "apple";
  if (/(^|\.)(mailspamprotection\.com|mimecast\.com|mimecast\.co\.uk|pphosted\.com|proofpoint\.com|barracudanetworks\.com|messagelabs\.com|symanteccloud\.com|iphmx\.com|mxthunder\.net|sophos\.com|trendmicro\.com|hornetsecurity\.com|antispamcloud\.com|spamexperts\.com|mxrecord\.io|mxlogic\.net)$/.test(h)) return "gateway";
  return "other";
}

/** provider -> pool name (or HOLD). Defaults: microsoft held, the rest to `default_pool` (maildoso). */
export async function routes() {
  const def = await getSetting("default_pool", "maildoso");
  const out = {};
  for (const p of PROVIDERS) out[p] = await getSetting(`route_${p}`, DEFAULT_ROUTE[p] || def);
  return out;
}

/** Distinct pools that have an enabled mailbox with a password. */
export async function pools() {
  return (await all("SELECT DISTINCT pool FROM mailboxes WHERE enabled AND smtp_pass IS NOT NULL AND smtp_pass<>'' ORDER BY pool")).map(r => r.pool);
}

/** Contacts per provider, active only. */
export async function providerCounts() {
  return all("SELECT COALESCE(mail_provider,'unclassified') AS provider, count(*)::int AS n FROM contacts WHERE status='active' GROUP BY 1 ORDER BY 2 DESC");
}
