/**
 * Replies to emails sent through Instantly never reach the mailer's IMAP poller (they land in the Instantly
 * mailboxes), and the Instantly->HubSpot connector only writes opens/clicks. So read them from Instantly's API
 * every 20 minutes and do what the IMAP path does for the mailer's own sends:
 *   - genuine reply  -> contacts.status=replied, HubSpot ukv_replied + instantly_engagement=replied
 *   - clear opt-out ("no thanks", "unsubscribe", ...) -> also unsubscribed + suppressed + HubSpot ukv_unsubscribed
 *   - auto-reply / "mailbox not monitored" -> logged only
 * Campaigns come from INSTANTLY_REPORT_CAMPAIGNS ("<id>:<site>,..."), key from INSTANTLY_REPORT_API_KEY.
 * Each Instantly email is processed once (events.detail = "instantly:<id>").
 */
import { q, one, all } from "./db.js";
import { syncEngagement } from "./hubspot.js";

export const instantlyReplyState = { lastRun: null, lastResult: "" };
const KEY = () => process.env.INSTANTLY_REPORT_API_KEY || "";
const CAMPAIGNS = () => String(process.env.INSTANTLY_REPORT_CAMPAIGNS || "2cecb091-fd83-4b06-a647-a9fa1ee64637:marketwatcher")
  .split(",").map(s => s.trim()).filter(Boolean).map(s => { const [id, site] = s.split(":"); return { id, site: site || "marketwatcher" }; });

const AUTO = /not monitored|auto(matic)?[\s-]*reply|out of (the )?office|automatische antwort|r[ée]ponse automatique|delivery (status|failure)|undeliverable/i;
const OPT_OUT = /^\W*(no[, ]+thanks?|no thank you|unsubscribe|remove me|please remove|stop( emailing| sending)?|not interested|take me off)\b/i;

const api = async (path) => {
  const r = await fetch(`https://api.instantly.ai/api/v2${path}`, { headers: { Authorization: `Bearer ${KEY()}` } });
  if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}`);
  return r.json();
};

export async function syncInstantlyReplies() {
  if (!KEY()) { instantlyReplyState.lastResult = "no INSTANTLY_REPORT_API_KEY"; return 0; }
  instantlyReplyState.lastRun = new Date();
  let fresh = 0, flagged = 0, optOuts = 0;
  try {
    for (const { id, site } of CAMPAIGNS()) {
      const campaign = { name: (await api(`/campaigns/${id}`)).name };
      let after, items = [];
      for (;;) {
        const j = await api(`/emails?campaign_id=${encodeURIComponent(id)}&email_type=received&limit=100${after ? "&starting_after=" + after : ""}`);
        items.push(...(j.items || []));
        if (!j.next_starting_after || !(j.items || []).length) break;
        after = j.next_starting_after;
      }
      for (const e of items) {
        const tag = `instantly:${e.id}`;
        if (await one("SELECT 1 AS x FROM events WHERE type IN ('reply','autoreply') AND detail LIKE $1 LIMIT 1", [tag + "%"])) continue;
        const email = String(e.lead || e.from_address_email || "").toLowerCase().trim();
        const contact = email && await one("SELECT * FROM contacts WHERE lower(email)=$1", [email]);
        if (!contact) continue;                                   // not one of ours
        fresh++;
        const text = String(e.content_preview || e.body?.text || "").trim();
        const subject = String(e.subject || "").slice(0, 120);
        if (AUTO.test(text.slice(0, 200)) || AUTO.test(subject)) {
          await q("INSERT INTO events(contact_id,type,detail) VALUES($1,'autoreply',$2)", [contact.id, `${tag} ${subject}`.slice(0, 300)]);
          continue;
        }
        await q("UPDATE contacts SET status='replied', updated_at=now() WHERE id=$1 AND status='active'", [contact.id]);
        await q("UPDATE enrolments SET status='stopped', stop_reason='replied' WHERE contact_id=$1 AND status='active'", [contact.id]);
        await q("INSERT INTO events(contact_id,type,detail) VALUES($1,'reply',$2)", [contact.id, `${tag} ${subject}`.slice(0, 300)]);
        syncEngagement({ contact, campaign, engagement: "replied", site });
        flagged++;
        if (OPT_OUT.test(text)) {
          await q("UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1", [contact.id]);
          await q("INSERT INTO suppressions(email,reason) VALUES($1,'instantly reply: opt-out') ON CONFLICT DO NOTHING", [contact.email]);
          await q("INSERT INTO events(contact_id,type,detail) VALUES($1,'unsubscribe',$2)", [contact.id, `${tag} reply opt-out`]);
          syncEngagement({ contact, campaign, engagement: "unsubscribed", site });
          optOuts++;
        }
      }
    }
    instantlyReplyState.lastResult = `${new Date().toISOString().slice(0, 16)}: ${fresh} new, ${flagged} replies flagged, ${optOuts} opt-outs`;
  } catch (e) { instantlyReplyState.lastResult = `error: ${e.message}`; console.warn("[instantly-replies]", e.message); }
  return flagged;
}

export function startInstantlyReplySync() {
  const run = () => syncInstantlyReplies().catch(e => console.warn("[instantly-replies]", e.message));
  setTimeout(run, 60_000);
  setInterval(run, 20 * 60_000);
}
