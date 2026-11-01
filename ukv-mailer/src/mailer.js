import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";

const transports = new Map(); // mailbox.id -> transporter

/** Per-mailbox SMTP endpoint (pool-specific), falling back to the SMTP_HOST/SMTP_PORT env. */
export function smtpFor(mailbox) {
  const google = mailbox.auth_type === "google";
  return {
    host: mailbox.smtp_host || (google ? "smtp.gmail.com" : cfg.smtp.host),
    port: Number(mailbox.smtp_port) || (google ? 465 : cfg.smtp.port),
  };
}

/**
 * Google Workspace service account with domain-wide delegation (scope https://mail.google.com/).
 * GOOGLE_SA_JSON = the service account's JSON key, raw or base64. One key serves every Workspace
 * mailbox, so no per-user app passwords or 2-step verification are needed.
 */
let sa;
function googleServiceAccount() {
  if (sa !== undefined) return sa;
  const raw = process.env.GOOGLE_SA_JSON || "";
  if (!raw) { sa = null; return sa; }
  const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const j = JSON.parse(json);
  sa = { serviceClient: j.client_id, privateKey: j.private_key, email: j.client_email };
  return sa;
}

/** nodemailer auth block for a mailbox: SMTP password, or OAuth2 via the service account. */
export function authFor(mailbox) {
  if (mailbox.auth_type === "google") {
    const g = googleServiceAccount();
    if (!g) throw new Error("GOOGLE_SA_JSON is not set (needed for Google Workspace mailboxes)");
    return { type: "OAuth2", user: mailbox.email, serviceClient: g.serviceClient, privateKey: g.privateKey };
  }
  return { user: mailbox.email, pass: mailbox.smtp_pass };
}

export function transportFor(mailbox) {
  const { host, port } = smtpFor(mailbox);
  const key = `${mailbox.id}:${host}:${port}:${mailbox.auth_type}:${mailbox.smtp_pass}`;
  if (!transports.has(key)) {
    transports.set(key, nodemailer.createTransport({
      host,
      port,
      secure: port === 465,          // 587 => STARTTLS
      requireTLS: port !== 465,
      auth: authFor(mailbox),
      pool: true, maxConnections: 1, maxMessages: 20,
      connectionTimeout: 20000, socketTimeout: 30000,
      tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined,
    }));
  }
  return transports.get(key);
}

/**
 * Send one email. Returns { messageId }.
 * inReplyTo: Message-ID of step 1 so follow-ups thread in the recipient's inbox.
 */
export async function sendMail({ mailbox, to, subject, html, text, unsubUrl, inReplyTo }) {
  const domain = mailbox.email.split("@")[1];
  const messageId = `<${randomUUID()}@${domain}>`;
  const t = transportFor(mailbox);
  const info = await t.sendMail({
    from: { name: mailbox.display_name, address: mailbox.email },
    to,
    subject,
    html,
    text,
    messageId,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      // No X-Mailer: Gmail surfaces it as "Using ukv-mailer", an automation tell.
    },
  });
  return { messageId: info.messageId || messageId };
}

export async function verifyMailbox(mailbox) {
  const { host, port } = smtpFor(mailbox);
  const t = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port !== 465,
    auth: authFor(mailbox), connectionTimeout: 15000,
    tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined,
  });
  await t.verify();
  t.close();
}

function cryptoId() {
  return Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
}
