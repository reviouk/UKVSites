import { cfg, SITES } from "./config.js";

/**
 * Merge fields: {{first_name}}, {{first_name|there}}, {{last_name}}, {{company}},
 * {{site_url}}, {{site_name}}, {{sender_name}}, {{sender_email}}.
 * Unknown fields render as the fallback (or empty).
 */
export function merge(text, vars) {
  return String(text || "").replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_, key, fallback = "") => {
    const k = key.toLowerCase().replace(/^contact\./, "");
    const v = vars[k];
    return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
  });
}

export function contactVars(contact, mailbox, site) {
  const s = SITES[site] || {};
  return {
    first_name: titleCase(contact.first_name),
    last_name: titleCase(contact.last_name),
    full_name: [titleCase(contact.first_name), titleCase(contact.last_name)].filter(Boolean).join(" "),
    company: contact.company || "",
    email: contact.email,
    site_url: s.url || "",
    site_name: s.label || "",
    sender_name: mailbox?.display_name || "",
    sender_email: mailbox?.email || "",
    sender_first_name: (mailbox?.display_name || "").split(" ")[0],
  };
}

function titleCase(s) {
  if (!s) return "";
  s = String(s).trim();
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s; // already mixed-case: keep
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

/** Turn plain-ish text (lines, blank-line paragraphs) into simple HTML. Leaves real HTML alone. */
export function toHtml(body) {
  const b = String(body || "");
  if (/<\s*(p|div|br|a|table|html)\b/i.test(b)) return b;
  return b.trim().split(/\n{2,}/).map(p => `<p>${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/** [text](url) -> styled link; bare URLs / {{site_url}} -> plain links. Runs on already-escaped text. */
function linkify(t) {
  // Plain text links only (no buttons) — reads like a personal email.
  const A = (href, text, cta) => `<a href="${href}" style="color:#7a2230;${cta ? "font-weight:600;" : ""}text-decoration:underline">${text}</a>`;
  return t
    .replace(/\[([^\]]+)\]\((\{\{\s*site_url\s*\}\}|https?:\/\/[^)\s]+)\)/g, (_, text, href) => A(href, text, true))
    .replace(/(^|[\s>])(https?:\/\/[^\s<]*[^\s<.,;:!?)])/g, (_, pre, url) => pre + A(url, url, false))
    .replace(/(^|[\s>])(\{\{\s*site_url\s*\}\})(?=$|[\s<.,])/g, (_, pre, tok) => pre + A(tok, tok, false));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Strip to plain text for the text/plain alternative. */
export function toText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>|<\/div>|<\/li>/gi, "\n\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => { const t = txt.replace(/<[^>]+>/g, "").trim(); return t === href ? href : `${t} (${href})`; })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Final assembly for one send: merge fields, rewrite links through /c/<token>,
 * append unsubscribe footer and open pixel.
 */
export function buildEmail({ step, contact, mailbox, site, token, vars }) {
  const subject = merge(step.subject, vars);
  let html = merge(toHtml(step.body_html), vars);

  // Rewrite every http(s) link through the click tracker (skip mailto/unsubscribe).
  html = html.replace(/href="(https?:\/\/[^"]+)"/gi, (_, url) =>
    `href="${cfg.baseUrl}/c/${token}?u=${encodeURIComponent(url)}"`);

  const unsubUrl = `${cfg.baseUrl}/u/${token}`;
  const footer = `
<p style="margin-top:28px;font-size:12px;line-height:1.5;color:#777">
Whisky cask ownership is a long-term investment in an unregulated market: it is not overseen by the FCA and is not covered by the Financial Services Compensation Scheme. The value of a cask can go down as well as up. This email is general information, not financial or tax advice.<br>
You are receiving this because your details are held on a marketing list. If you would rather not hear from us again, <a href="${unsubUrl}" style="color:#777">unsubscribe here</a> and we will remove you immediately.
</p>
<img src="${cfg.baseUrl}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;

  const fullHtml = `<!doctype html><html><body style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#222;max-width:620px">${html}${footer}</body></html>`;
  const text = toText(html) + `\n\n--\nUnsubscribe: ${unsubUrl}`;
  return { subject, html: fullHtml, text, unsubUrl };
}
