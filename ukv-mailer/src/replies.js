/**
 * Reply + bounce detection. Polls the Maildoso master inbox (every Maildoso mailbox forwards
 * there) plus the own INBOX of every mailbox flagged imap_poll (Gmail boxes on app passwords), matches each new message back to a send by In-Reply-To /
 * References / recipient address, and:
 *   - real reply      -> contact.status=replied, all sequences stopped, HubSpot ukv_replied
 *   - bounce (DSN)    -> contact.status=bounced, suppressed, sequences stopped
 *   - auto-reply/OOO  -> logged only, sequence continues
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { cfg } from "./config.js";
import { q, one, all, getSetting, setSetting } from "./db.js";
import { syncEngagement } from "./hubspot.js";

export const replyState = { lastPoll: null, lastResult: "", configured: !!(cfg.imap.host && cfg.imap.user && cfg.imap.pass) };
let busy = false;

export function startReplyPoller() {
  if (!replyState.configured) console.warn("[imap] IMAP_HOST/IMAP_USER/IMAP_PASS not set; master inbox not polled (per-mailbox inboxes still are)");
  poll().catch(e => console.error("[imap] poll error", e.message));
  setInterval(() => poll().catch(e => console.error("[imap] poll error", e.message)), cfg.imap.pollMinutes * 60_000);
}

/** Every inbox to read: the master inbox (env) and each enabled mailbox flagged imap_poll. */
async function sources() {
  const list = [];
  if (replyState.configured) list.push({ label: "master", host: cfg.imap.host, port: cfg.imap.port, user: cfg.imap.user, pass: cfg.imap.pass, uidKey: "imap_last_uid" });
  const boxes = await all("SELECT id, email, imap_host, imap_port, imap_pass, smtp_pass FROM mailboxes WHERE imap_poll AND enabled ORDER BY id");
  for (const b of boxes) {
    const pass = b.imap_pass || b.smtp_pass;
    if (!pass) continue;
    list.push({ label: b.email, mailboxId: b.id, host: b.imap_host || "imap.gmail.com", port: Number(b.imap_port) || 993, user: b.email, pass, uidKey: `imap_last_uid:mb${b.id}` });
  }
  return list;
}

export async function poll() {
  if (busy) return;
  busy = true;
  replyState.lastPoll = new Date();
  let fresh = 0, handled = 0;
  const errors = [];
  try {
    for (const src of await sources()) {
      try {
        const r = await pollInbox(src);
        fresh += r.fresh; handled += r.handled;
      } catch (e) {
        errors.push(`${src.label}: ${e.message}`);
        console.error(`[imap] ${src.label}: ${e.message}`);
        if (src.mailboxId) await q("UPDATE mailboxes SET last_error=$2, last_error_at=now() WHERE id=$1", [src.mailboxId, `IMAP: ${e.message}`.slice(0, 300)]).catch(() => {});
      }
    }
    replyState.lastResult = `${fresh} new message(s), ${handled} processed` + (errors.length ? `; ${errors.length} inbox error(s): ${errors[0].slice(0, 120)}` : "");
  } finally { busy = false; }
}

async function pollInbox(src) {
  const client = new ImapFlow({
    host: src.host, port: src.port, secure: true,
    auth: { user: src.user, pass: src.pass },
    logger: false,
    tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined,
  });
  let handled = 0, count = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const lastUid = Number(await getSetting(src.uidKey, 0));
      const uids = await client.search(lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 2 * 86400e3) }, { uid: true });
      const fresh = (uids || []).filter(u => u > lastUid);
      count = fresh.length;
      for (const uid of fresh) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg?.source) continue;
          const parsed = await simpleParser(msg.source);
          await handleMessage(parsed, uid);
          handled++;
        } catch (e) {
          console.warn(`[imap] ${src.label} uid ${uid}: ${e.message}`);
        }
        await setSetting(src.uidKey, uid);
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch {}
    throw e;
  }
  return { fresh: count, handled };
}

const addr = (a) => (a?.value?.[0]?.address || "").toLowerCase().trim();
const allAddrs = (a) => (a?.value || []).map(v => (v.address || "").toLowerCase());

async function handleMessage(m, uid) {
  const from = addr(m.from);
  const subject = m.subject || "";
  const text = (m.text || "").slice(0, 4000);
  const headers = m.headers;
  const inReplyTo = (m.inReplyTo || "").trim();
  const references = Array.isArray(m.references) ? m.references : (m.references ? [m.references] : []);

  const isBounce = /mailer-daemon|postmaster|mail delivery|delivery status|undeliverable/i.test(from + " " + subject)
    || /multipart\/report/i.test(headers.get("content-type")?.value || "");
  const autoSubmitted = String(headers.get("auto-submitted") || "").toLowerCase();
  const isAuto = (autoSubmitted && autoSubmitted !== "no")
    || headers.has("x-autoreply") || headers.has("x-autorespond")
    || /^(auto(matic)?[\s-]*reply|out of (the )?office|automatische antwort|réponse automatique)/i.test(subject);

  // 1. Match to a send via threading headers.
  let send = null;
  const ids = [inReplyTo, ...references].filter(Boolean);
  if (ids.length) send = await one("SELECT * FROM sends WHERE message_id = ANY($1) ORDER BY sent_at DESC LIMIT 1", [ids]);

  // 2. Bounces: find the failed recipient address anywhere in the body / headers.
  let contact = null;
  if (!send && isBounce) {
    const candidates = new Set([...(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(s => s.toLowerCase())]);
    const orig = String(headers.get("x-failed-recipients") || headers.get("original-recipient") || "").toLowerCase();
    for (const e of orig.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []) candidates.add(e);
    if (candidates.size) {
      contact = await one("SELECT * FROM contacts WHERE email = ANY($1) ORDER BY updated_at DESC LIMIT 1", [[...candidates]]);
      if (contact) send = await one("SELECT * FROM sends WHERE contact_id=$1 ORDER BY sent_at DESC LIMIT 1", [contact.id]);
    }
  }
  // 3. Plain reply with no headers: match sender address to a contact we have emailed.
  if (!send && !isBounce && from) {
    contact = await one("SELECT * FROM contacts WHERE email=$1", [from]);
    if (contact) send = await one("SELECT * FROM sends WHERE contact_id=$1 ORDER BY sent_at DESC LIMIT 1", [contact.id]);
  }
  if (send && !contact) contact = await one("SELECT * FROM contacts WHERE id=$1", [send.contact_id]);
  if (!contact) return; // not ours (e.g. a Maildoso system email)

  await q("INSERT INTO replies(send_id,contact_id,from_email,subject,snippet,is_bounce,imap_uid) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [send?.id || null, contact.id, from, subject.slice(0, 300), text.slice(0, 1000), isBounce, uid]);

  const campaign = send ? await one("SELECT * FROM campaigns WHERE id=$1", [send.campaign_id]) : null;

  if (isBounce) {
    // Classify: DSN status 5.x.x = hard (bad address), 4.x.x = soft (temporary). A soft
    // bounce is logged; the contact is suppressed on a hard bounce or a second soft bounce.
    const code = (text.match(/\b([245])\.\d{1,3}\.\d{1,3}\b/) || [])[1]
      || (/user unknown|does not exist|no such user|invalid recipient|recipient rejected|address rejected|mailbox unavailable|\b550\b/i.test(text) ? "5"
      : /mailbox full|quota|try again|temporar|deferred|delayed|\b42[01]\b|\b45[012]\b/i.test(text) ? "4" : "");
    const reason = ((text.match(/(?:status|diagnostic-code|reason)\s*:\s*([^\n]{0,160})/i) || [])[1] || subject).slice(0, 160).trim();
    const bounceType = code === "4" ? "soft" : "hard";
    const prior = await one("SELECT count(*)::int n FROM events WHERE contact_id=$1 AND type='bounce'", [contact.id]);
    await q("INSERT INTO events(send_id,contact_id,type,detail) VALUES($1,$2,'bounce',$3)", [send?.id || null, contact.id, `${bounceType}: ${reason}`.slice(0, 300)]);
    if (send) await q("UPDATE sends SET status='bounced', bounce_type=$2, error=$3 WHERE id=$1", [send.id, bounceType, reason]);
    if (bounceType === "soft" && prior.n === 0) {
      // give it one retry window: push the next step out by 2 days instead of stopping
      await q("UPDATE enrolments SET next_due_at = GREATEST(next_due_at, now() + interval '2 days') WHERE contact_id=$1 AND status='active'", [contact.id]);
      console.log(`[imap] soft bounce (1st, retrying later): ${contact.email}`);
      return;
    }
    await q("UPDATE contacts SET status='bounced', updated_at=now() WHERE id=$1 AND status='active'", [contact.id]);
    await q("INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT DO NOTHING", [contact.email, `bounce:${bounceType}`]);
    await q("UPDATE enrolments SET status='stopped', stop_reason='bounced' WHERE contact_id=$1 AND status='active'", [contact.id]);
    console.log(`[imap] ${bounceType} bounce: ${contact.email}`);
    return;
  }
  if (isAuto) {
    await q("INSERT INTO events(send_id,contact_id,type,detail) VALUES($1,$2,'autoreply',$3)", [send?.id || null, contact.id, subject.slice(0, 300)]);
    return;
  }
  // Genuine reply
  await q("UPDATE contacts SET status='replied', updated_at=now() WHERE id=$1 AND status IN ('active')", [contact.id]);
  await q("UPDATE enrolments SET status='stopped', stop_reason='replied' WHERE contact_id=$1 AND status='active'", [contact.id]);
  if (send) await q("UPDATE sends SET replied_at=COALESCE(replied_at, now()) WHERE id=$1", [send.id]);
  await q("INSERT INTO events(send_id,contact_id,type,detail) VALUES($1,$2,'reply',$3)", [send?.id || null, contact.id, subject.slice(0, 300)]);
  syncEngagement({ contact, campaign, engagement: "replied", site: campaign?.site || contact.site });
  console.log(`[imap] reply from ${contact.email}: ${subject.slice(0, 80)}`);
}

export async function recentReplies(limit = 50) {
  return all(`
    SELECT r.*, c.first_name, c.last_name, c.email, c.status AS contact_status, cp.name AS campaign_name, m.email AS mailbox_email
      FROM replies r JOIN contacts c ON c.id = r.contact_id
      LEFT JOIN sends s ON s.id = r.send_id LEFT JOIN campaigns cp ON cp.id = s.campaign_id LEFT JOIN mailboxes m ON m.id = s.mailbox_id
     ORDER BY r.received_at DESC LIMIT $1`, [limit]);
}
