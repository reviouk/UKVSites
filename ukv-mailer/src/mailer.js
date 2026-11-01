import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";

const transports = new Map(); // mailbox.id -> transporter

export function transportFor(mailbox) {
  const key = `${mailbox.id}:${mailbox.smtp_pass}`;
  if (!transports.has(key)) {
    transports.set(key, nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.port === 465,          // 587 => STARTTLS
      requireTLS: cfg.smtp.port !== 465,
      auth: { user: mailbox.email, pass: mailbox.smtp_pass },
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
  const t = nodemailer.createTransport({
    host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465, requireTLS: cfg.smtp.port !== 465,
    auth: { user: mailbox.email, pass: mailbox.smtp_pass }, connectionTimeout: 15000,
    tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? { rejectUnauthorized: false } : undefined,
  });
  await t.verify();
  t.close();
}

function cryptoId() {
  return Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
}
