#!/usr/bin/env node
/**
 * Historical scan of every Maildoso mailbox over IMAP (the only real "log" of
 * what Instantly sent):
 *   Sent folder  -> every recipient address  => contacts.instantly_contacted = true
 *   INBOX        -> bounce notices (DSN)     => contact bounced + suppressed
 *                -> replies from contacts    => contact replied (sequence will not enrol)
 *
 *   node scripts/scan-mailboxes.mjs <maildoso-accounts-export.csv> [--dry-run] [--since 2026-01-01]
 *
 * The export CSV has: email, imap_username, imap_password, imap_host, imap_port.
 * Also stores each mailbox's IMAP host/password in the mailboxes table.
 */
import "./_env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : new Date("2026-01-01");
const file = args.find(a => a.endsWith(".csv"));
if (!file) { console.error("usage: node scripts/scan-mailboxes.mjs accounts.csv [--dry-run] [--since YYYY-MM-DD]"); process.exit(1); }

const rows = parse(readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true, trim: true });
const { q, all, pool } = await import("../src/db.js");
const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const own = new Set(rows.map(r => r.email.toLowerCase()));
const isOwn = (e) => own.has(e) || /maildoso\.(email|com)$/.test(e);

const sent = new Map();     // recipient -> { count, first, last, mailbox }
const bounced = new Map();  // recipient -> reason
const replied = new Map();  // sender -> { subject, date, mailbox }
const perMailbox = [];

for (const r of rows) {
  const box = { email: r.email.toLowerCase(), host: r.imap_host, port: Number(r.imap_port || 993), user: r.imap_username || r.email, pass: r.imap_password };
  if (!DRY) {
    await q("ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_host TEXT, ADD COLUMN IF NOT EXISTS imap_pass TEXT");
    await q("UPDATE mailboxes SET imap_host=$2, imap_pass=$3 WHERE email=$1", [box.email, box.host, box.pass]);
  }
  const stat = { mailbox: box.email, sent: 0, inbox: 0, bounces: 0, replies: 0, error: "" };
  const client = new ImapFlow({ host: box.host, port: box.port, secure: true, auth: { user: box.user, pass: box.pass }, logger: false,
    tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined });
  try {
    await client.connect();
    const folders = await client.list();
    const sentFolder = folders.find(f => f.specialUse === "\\Sent") || folders.find(f => /^sent/i.test(f.name) || /sent/i.test(f.path));
    // --- Sent ---
    if (sentFolder) {
      const lock = await client.getMailboxLock(sentFolder.path);
      try {
        for await (const msg of client.fetch({ since: SINCE }, { envelope: true })) {
          const env = msg.envelope;
          const tos = [...(env.to || []), ...(env.cc || []), ...(env.bcc || [])].map(a => (a.address || "").toLowerCase()).filter(a => a && !isOwn(a));
          for (const to of tos) {
            const d = env.date ? new Date(env.date) : null;
            const cur = sent.get(to) || { count: 0, first: d, last: d, mailbox: box.email };
            cur.count++; if (d && (!cur.first || d < cur.first)) cur.first = d; if (d && (!cur.last || d > cur.last)) cur.last = d;
            sent.set(to, cur);
          }
          stat.sent++;
        }
      } finally { lock.release(); }
    } else stat.error += "no Sent folder; ";
    // --- INBOX ---
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ since: SINCE }, { envelope: true, uid: true })) {
        stat.inbox++;
        const env = msg.envelope;
        const from = (env.from?.[0]?.address || "").toLowerCase();
        const subject = env.subject || "";
        const isBounce = /mailer-daemon|postmaster|mail delivery|delivery status|undeliver|returned mail|failure notice/i.test(from + " " + subject);
        if (isBounce) {
          const full = await client.fetchOne(msg.uid, { source: true }, { uid: true });
          const parsed = await simpleParser(full.source);
          const text = (parsed.text || "") + " " + String(parsed.headers.get("x-failed-recipients") || "");
          const found = new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()).filter(e => !isOwn(e) && !/mailer-daemon|postmaster|noreply|no-reply/.test(e)));
          for (const e of found) if (!bounced.has(e)) bounced.set(e, subject.slice(0, 120));
          stat.bounces++;
        } else if (from && !isOwn(from) && !/noreply|no-reply|notification|mailer|newsletter|support@|info@maildoso/i.test(from)) {
          const auto = /^(auto(matic)?[\s-]*reply|out of (the )?office)/i.test(subject);
          if (!auto && !replied.has(from)) replied.set(from, { subject: subject.slice(0, 120), date: env.date, mailbox: box.email });
          if (!auto) stat.replies++;
        }
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    stat.error += e.message.slice(0, 120);
    try { await client.logout(); } catch {}
  }
  perMailbox.push(stat);
  console.log(`${box.email.padEnd(42)} sent ${String(stat.sent).padStart(5)}  inbox ${String(stat.inbox).padStart(5)}  bounces ${String(stat.bounces).padStart(4)}  replies ${String(stat.replies).padStart(4)}  ${stat.error}`);
}

console.log(`\nUnique recipients emailed: ${sent.size}\nUnique bounced addresses:  ${bounced.size}\nUnique repliers:           ${replied.size}`);

// Which of these are in our contacts table?
const known = new Map((await all("SELECT id, email, status FROM contacts WHERE email = ANY($1)", [[...new Set([...sent.keys(), ...bounced.keys(), ...replied.keys()])]])).map(c => [c.email, c]));
const sentKnown = [...sent.keys()].filter(e => known.has(e));
const bouncedKnown = [...bounced.keys()].filter(e => known.has(e));
const repliedKnown = [...replied.keys()].filter(e => known.has(e));
console.log(`In our contacts: emailed ${sentKnown.length}, bounced ${bouncedKnown.length}, replied ${repliedKnown.length}`);

const report = { scannedAt: new Date().toISOString(), since: SINCE, perMailbox,
  sent: [...sent].map(([e, v]) => ({ email: e, ...v })), bounced: [...bounced].map(([e, r]) => ({ email: e, reason: r })),
  replied: [...replied].map(([e, v]) => ({ email: e, ...v })) };
writeFileSync("import/mailbox-scan.json", JSON.stringify(report, null, 1));
console.log("report written to import/mailbox-scan.json");

if (DRY) { console.log("DRY RUN — database not updated"); await pool.end(); process.exit(0); }

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
let n1 = 0, n2 = 0, n3 = 0;
for (const part of chunk([...sent.keys()], 5000)) {
  n1 += (await q(`UPDATE contacts SET instantly_contacted=true, instantly_status=COALESCE(instantly_status,'sent (found in mailbox Sent folder)') WHERE email = ANY($1)`, [part])).rowCount;
}
for (const part of chunk([...bounced.keys()], 5000)) {
  await q(`INSERT INTO suppressions(email,reason) SELECT unnest($1::text[]), 'bounce (pre-ukv-mailer)' ON CONFLICT DO NOTHING`, [part]);
  n2 += (await q(`UPDATE contacts SET status='bounced', instantly_status='bounced', updated_at=now() WHERE email = ANY($1) AND status='active'`, [part])).rowCount;
  await q(`UPDATE enrolments SET status='stopped', stop_reason='bounced' WHERE status='active' AND contact_id IN (SELECT id FROM contacts WHERE email = ANY($1))`, [part]);
}
for (const part of chunk([...replied.keys()], 5000)) {
  n3 += (await q(`UPDATE contacts SET status='replied', instantly_status='replied', updated_at=now() WHERE email = ANY($1) AND status='active'`, [part])).rowCount;
  await q(`UPDATE enrolments SET status='stopped', stop_reason='replied' WHERE status='active' AND contact_id IN (SELECT id FROM contacts WHERE email = ANY($1))`, [part]);
}
console.log(`DB updated: ${n1} marked already-contacted, ${n2} marked bounced+suppressed, ${n3} marked replied`);
await pool.end();
