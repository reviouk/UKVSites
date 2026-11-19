/**
 * Replies that mean "stop": a plain "no thanks", or a complaint ("how did you get my email?",
 * "remove me", "GDPR", "this is spam"...). Rob (19 Nov 2026): remove these automatically.
 * Opt-out = contact unsubscribed + suppressed, enrolments stopped, HubSpot ukv_unsubscribed,
 * and the address added to the Instantly workspace blocklist so no Instantly campaign emails it either.
 */
import { q } from "./db.js";
import { syncEngagement } from "./hubspot.js";

// Only the person's own words: drop the quoted original (our email has an unsubscribe line in it).
export function replyOnly(text) {
  const t = String(text || "").replace(/\r/g, "");
  const cut = t.search(/(^|\s)On [^\n]{0,120}\d{4}[\s\S]{0,140}?wrote:|^\s*(From:|-{2,}\s*Original|_{5,}|>)|Sent from my (iPhone|iPad|Android|Galaxy|mobile)|\s>\s*On\s/im);
  return (cut >= 0 ? t.slice(0, cut) : t).slice(0, 1500);
}

const START = /^\W*(no[, ]+thanks?|no thank you|unsubscribe|remove me|please remove|stop( emailing| sending)?|not interested|take me off)\b/i;
const ANYWHERE = new RegExp([
  String.raw`how (did|have|do) you (get|got|obtain(ed)?|find|found|come by) (hold of )?(my|this) (e-?mail|address|details|data|info)`,
  String.raw`where (did|have) you (get|got|obtain(ed)?|find|found) (my|this)`,
  String.raw`who (gave|sold|passed) you my`,
  String.raw`(remove|delete|erase|take) (me|my (e-?mail|address|details|data))`,
  String.raw`unsubscribe`, String.raw`opt(ed)?[ -]?out`,
  String.raw`stop (e-?mailing|sending|contacting|spamming)`,
  String.raw`(do not|don'?t|never) (e-?mail|contact|message|write to) me`,
  String.raw`not interested`, String.raw`\bgdpr\b`, String.raw`data protection`, String.raw`subject access`, String.raw`\bico\b`,
  String.raw`\bspam(ming|med)?\b`, String.raw`report(ing)? (you|this)`, String.raw`private (e-?mail|address)`,
  String.raw`never (gave|given|signed up|subscribed|agreed)`,
].join("|"), "i");

export function isOptOut(text, subject = "") {
  const own = replyOnly(text).trim();
  return START.test(own) || ANYWHERE.test(own) || /\b(unsubscribe|remove me)\b/i.test(subject);
}

const blocked = new Set();
async function blockInInstantly(email) {
  const key = process.env.INSTANTLY_REPORT_API_KEY;
  if (!key || blocked.has(email)) return;
  try {
    const r = await fetch("https://api.instantly.ai/api/v2/block-lists-entries", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ bl_value: email }) });
    if (r.ok || r.status === 409) blocked.add(email);
    else console.warn(`[optout] Instantly blocklist ${email}: ${r.status} ${(await r.text()).slice(0, 150)}`);
  } catch (e) { console.warn("[optout] Instantly blocklist", e.message); }
}

export async function optOut({ contact, campaign, site, sendId = null, why }) {
  await q("UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1", [contact.id]);
  await q("UPDATE enrolments SET status='stopped', stop_reason='unsubscribed' WHERE contact_id=$1 AND status='active'", [contact.id]);
  await q("INSERT INTO suppressions(email,reason) VALUES($1,$2) ON CONFLICT DO NOTHING", [contact.email, `reply opt-out${why ? ": " + why : ""}`.slice(0, 200)]);
  await q("INSERT INTO events(send_id,contact_id,type,detail) VALUES($1,$2,'unsubscribe',$3)", [sendId, contact.id, `reply opt-out ${why || ""}`.slice(0, 300)]);
  syncEngagement({ contact, campaign, engagement: "unsubscribed", site });
  await blockInInstantly(String(contact.email).toLowerCase());
}
