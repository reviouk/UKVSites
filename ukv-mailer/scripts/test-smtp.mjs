#!/usr/bin/env node
/** Verify SMTP login for every mailbox that has a password (or one: node scripts/test-smtp.mjs j.whitfield@...). */
import "./_env.mjs";
const { all, q, pool } = await import("../src/db.js");
const { verifyMailbox } = await import("../src/mailer.js");
const only = process.argv[2];
const boxes = await all("SELECT * FROM mailboxes WHERE smtp_pass IS NOT NULL AND smtp_pass<>'' " + (only ? "AND email=$1" : "") + " ORDER BY email", only ? [only] : []);
let ok = 0;
for (const m of boxes) {
  try { await verifyMailbox(m); ok++; console.log(`OK    ${m.email}`); await q("UPDATE mailboxes SET last_error=NULL WHERE id=$1", [m.id]); }
  catch (e) { console.log(`FAIL  ${m.email}: ${e.message}`); await q("UPDATE mailboxes SET last_error=$2, last_error_at=now() WHERE id=$1", [m.id, e.message.slice(0, 500)]); }
}
console.log(`${ok}/${boxes.length} mailboxes authenticated`);
await pool.end();
