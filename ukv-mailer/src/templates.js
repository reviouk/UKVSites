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
    brand_color: s.color || "#7a2230",
  };
}

function titleCase(s) {
  if (!s) return "";
  s = String(s).trim();
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s; // already mixed-case: keep
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

/**
 * Turn plain-ish text (lines, blank-line paragraphs) into simple HTML. Leaves real HTML alone.
 * Two block markers, each on a paragraph of its own (no images, so they stay light for spam filters):
 *   [[button: Label]](url)   a text-style button in the brand colour ({{brand_color}})
 *   [[video: Label]](url)    a "▶ Label" link; dropped entirely while url is empty or "none"
 */
export function toHtml(body) {
  const b = String(body || "");
  if (/<\s*(p|div|br|a|table|html)\b/i.test(b)) return b;
  return b.trim().split(/\n{2,}/).map(p => block(p.trim()) ?? `<p>${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`).filter(Boolean).join("\n");
}

function block(p) {
  const m = p.match(/^\[\[(button|video)\s*:\s*([^\]]+)\]\]\(\s*([^)]*?)\s*\)$/i);
  if (!m) return null;
  const [, kind, label, rawUrl] = m;
  const url = /^(https?:\/\/\S+|\{\{\s*site_url\s*\}\})$/i.test(rawUrl) ? escapeHtml(rawUrl) : "";
  if (!url) return "";                                  // no usable link: leave the block out
  if (kind.toLowerCase() === "video")
    return `<p style="margin:18px 0"><a href="${url}" style="color:#666666;text-decoration:underline">▶ ${escapeHtml(label.trim())}</a></p>`;
  return `<p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:{{brand_color}};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:1.2;padding:13px 24px;border-radius:4px;text-decoration:none">${escapeHtml(label.trim())}</a></p>`;
}

/** [text](url) -> styled link; bare URLs / {{site_url}} -> plain links. Runs on already-escaped text. */
function linkify(t) {
  // Plain text links only (no buttons) — reads like a personal email.
  // Links to the brand site ({{site_url}}) are the main call to action; any other link
  // (press articles, sources) is a quieter secondary link.
  const A = (href, text, cta) => cta
    ? `<a href="${href}" style="color:{{brand_color}};font-weight:600;text-decoration:underline">${text}</a>`
    : `<a href="${href}" style="color:#666666;text-decoration:underline">${text}</a>`;
  return t
    .replace(/\[([^\]]+)\]\((\{\{\s*site_url\s*\}\}|https?:\/\/[^)\s]+)\)/g, (_, text, href) => A(href, text, /site_url/.test(href)))
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
  const base = (SITES[site] && SITES[site].trackUrl) || cfg.baseUrl;
  const tracked = step.position > 1 || cfg.trackStep1;              // open pixel
  const trackClicks = tracked || cfg.trackStep1Clicks;              // link rewriting

  // Rewrite every http(s) link through the click tracker (skip mailto/unsubscribe).
  if (trackClicks) html = html.replace(/href="(https?:\/\/[^"]+)"/gi, (_, url) =>
    `href="${base}/c/${token}?u=${encodeURIComponent(url)}"`);

  const unsubUrl = `${base}/u/${token}`;
  const footer = `
<p style="margin-top:28px;font-size:12px;line-height:1.5;color:#777">
Whisky cask ownership is a long-term investment in an unregulated market: it is not overseen by the FCA and is not covered by the Financial Services Compensation Scheme. The value of a cask can go down as well as up. This email is general information, not financial or tax advice.<br>
You are receiving this because your details are held on a marketing list. If you would rather not hear from us again, <a href="${unsubUrl}" style="color:#777">unsubscribe here</a> and we will remove you immediately.
</p>${tracked ? `
<img src="${base}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : ""}`;

  // Preheader: hidden preview text shown by inbox clients next to the subject.
  // Hidden preheaders trip SpamAssassin's FONT_INVIS_MSGID (+2.5) via Maildoso's relay, so
  // they are off unless PREHEADER_HIDDEN=true. The inbox then previews the first body line.
  const pre = process.env.PREHEADER_HIDDEN === "true" ? merge(step.preheader || "", vars).trim() : "";
  const preheader = pre
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;opacity:0">${escapeHtml(pre)}${"&zwnj;&nbsp;".repeat(40)}</div>`
    : "";
  const fullHtml = `<!doctype html><html><body style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#222;max-width:620px">${preheader}${html}${footer}</body></html>`;
  const text = toText(html) + `\n\n--\nUnsubscribe: ${unsubUrl}`;
  return { subject, html: fullHtml, text, unsubUrl };
}
