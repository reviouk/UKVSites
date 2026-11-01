/**
 * Password-protected admin UI (HTTP basic auth). Server-rendered, no build step.
 */
import { Router } from "express";
import basicAuth from "basic-auth";
import multer from "multer";
import express from "express";
import { cfg, SITES, inSendWindow } from "./config.js";
import { q, one, all, getSetting, setSetting } from "./db.js";
import { todaysCounts, state as senderState, effectiveDailyTotal, allowances, warmupCap } from "./sender.js";
import { replyState, recentReplies, poll as pollReplies } from "./replies.js";
import { importFile } from "./importer.js";
import { syncConversions, convState } from "./conversions.js";
import { cbState, recentEvents, tick as callbackTick } from "./callbacks.js";
import { verifyMailbox } from "./mailer.js";
import { escapeHtml as h, toHtml, merge } from "./templates.js";

export const admin = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

admin.use((req, res, next) => {
  const c = basicAuth(req);
  if (!cfg.admin.pass || !c || c.name !== cfg.admin.user || c.pass !== cfg.admin.pass) {
    res.set("WWW-Authenticate", 'Basic realm="ukv-mailer"');
    return res.status(401).send(cfg.admin.pass ? "Auth required" : "Set ADMIN_PASS to enable the admin UI");
  }
  next();
});
admin.use(express.urlencoded({ extended: true, limit: "5mb" }));

// ---- layout ------------------------------------------------------------------
function page(title, body, flash = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(title)} · ukv-mailer</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1b2430;background:#f6f7f9;margin:0}
header{background:#16202e;color:#fff;padding:12px 24px;display:flex;gap:22px;align-items:center;flex-wrap:wrap}
header a{color:#cfd8e3;text-decoration:none;font-weight:500}header a:hover{color:#fff}header .brand{color:#f0c45a;font-weight:700;letter-spacing:.04em}
main{max-width:1200px;margin:0 auto;padding:22px 24px 60px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:28px 0 10px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e6ea}th,td{padding:7px 10px;border-bottom:1px solid #eef0f2;text-align:left;vertical-align:top}th{background:#f0f2f5;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}.card{background:#fff;border:1px solid #e3e6ea;padding:14px 16px}.card b{display:block;font-size:26px;font-weight:600}.card span{color:#5b6775;font-size:12px}
.ok{color:#1b7f3b}.bad{color:#b42318}.muted{color:#7a8594}
button,.btn{background:#16202e;color:#fff;border:0;padding:7px 14px;cursor:pointer;font:inherit;border-radius:3px}button.sec{background:#e3e6ea;color:#1b2430}button.danger{background:#b42318}
input[type=text],input[type=number],input[type=password],select,textarea{font:inherit;padding:6px 8px;border:1px solid #c9cfd6;border-radius:3px;width:100%;box-sizing:border-box}textarea{min-height:140px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
form.inline{display:inline}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.flash{background:#e8f5ec;border:1px solid #bfe3c9;padding:10px 14px;margin-bottom:16px}.flash.err{background:#fdecea;border-color:#f5c2bd}
.box{background:#fff;border:1px solid #e3e6ea;padding:16px;margin-bottom:16px}label{display:block;font-weight:600;margin:10px 0 4px;font-size:12px}small{color:#5b6775}
pre{background:#f0f2f5;padding:10px;overflow:auto;font-size:12px}
</style></head><body>
<header><span class="brand">UKV MAILER</span>
<a href="/admin">Dashboard</a><a href="/admin/campaigns">Campaigns</a><a href="/admin/stats">Stats</a><a href="/admin/contacts">Contacts</a><a href="/admin/mailboxes">Mailboxes</a><a href="/admin/replies">Replies</a><a href="/admin/callbacks">Call-backs</a><a href="/admin/settings">Settings</a></header>
<main>${flash ? `<div class="flash ${/^(Error|Failed)/i.test(flash) ? "err" : ""}">${h(flash)}</div>` : ""}${body}</main></body></html>`;
}
const flashOf = (req) => (req.query.msg ? String(req.query.msg) : "");
const redirect = (res, to, msg) => res.redirect(`${to}${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const fmt = (d) => d ? new Date(d).toLocaleString("en-GB", { timeZone: cfg.tz }) : "";

// ---- dashboard ---------------------------------------------------------------
admin.get("/", async (req, res) => {
  const { total, perMailbox } = await todaysCounts();
  const ramp = await effectiveDailyTotal();
  const dailyTotal = ramp.total;
  const paused = (await getSetting("paused", "false")) === "true";
  const totals = await one(`
    SELECT (SELECT count(*) FROM contacts)::int AS contacts,
           (SELECT count(*) FROM contacts WHERE status='active')::int AS active,
           (SELECT count(*) FROM enrolments WHERE status='active')::int AS queued,
           (SELECT count(*) FROM sends WHERE status<>'failed')::int AS sent_all,
           (SELECT count(*) FROM sends WHERE opened_at IS NOT NULL)::int AS opened,
           (SELECT count(*) FROM sends WHERE clicked_at IS NOT NULL)::int AS clicked,
           (SELECT count(*) FROM sends WHERE replied_at IS NOT NULL)::int AS replied,
           (SELECT count(*) FROM sends WHERE status='bounced')::int AS bounced,
           (SELECT count(*) FROM suppressions)::int AS suppressed`);
  const daily = await all(`
    SELECT to_char(sent_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, count(*)::int AS sent,
           count(opened_at)::int AS opened, count(clicked_at)::int AS clicked, count(replied_at)::int AS replied
      FROM sends WHERE status<>'failed' AND sent_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1 DESC`, [cfg.tz]);
  const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : "–";
  const body = `
<h1>Dashboard</h1>
<div class="cards">
  <div class="card"><b>${total} / ${dailyTotal}</b><span>sent today · ${h(ramp.phase)}${ramp.day ? ` · day ${ramp.day}` : ""}</span></div>
  <div class="card"><b class="${paused ? "bad" : inSendWindow() ? "ok" : "muted"}">${paused ? "PAUSED" : inSendWindow() ? "SENDING" : "Outside window"}</b><span>${h(senderState.lastResult || "")}<br>window ${cfg.windowStart}–${cfg.windowEnd} ${cfg.tz}, days ${cfg.sendDays.join(",")}</span></div>
  <div class="card"><b>${totals.queued}</b><span>contacts queued in active sequences</span></div>
  <div class="card"><b>${totals.active} <small>/ ${totals.contacts}</small></b><span>active contacts / total</span></div>
  <div class="card"><b>${totals.sent_all}</b><span>sent all time</span></div>
  <div class="card"><b>${pct(totals.opened, totals.sent_all)}</b><span>opened (${totals.opened}) – noisy</span></div>
  <div class="card"><b>${pct(totals.clicked, totals.sent_all)}</b><span>clicked (${totals.clicked})</span></div>
  <div class="card"><b>${pct(totals.replied, totals.sent_all)}</b><span>replied (${totals.replied})</span></div>
  <div class="card"><b>${totals.bounced}</b><span>bounced · ${totals.suppressed} suppressed</span></div>
  <div class="card"><b class="${replyState.configured ? "ok" : "bad"}">${replyState.configured ? "IMAP on" : "IMAP off"}</b><span>${h(replyState.lastResult || "")}<br>${fmt(replyState.lastPoll)}</span></div>
</div>
<form method="post" action="/admin/toggle-pause" class="inline"><button class="${paused ? "" : "danger"}">${paused ? "Resume sending" : "Pause all sending"}</button></form>
<h2>Mailboxes today</h2>
<table><tr><th>Mailbox</th><th>Persona</th><th>Site</th><th>Sent today</th><th>Cap</th><th>Status</th></tr>
${perMailbox.map(m => `<tr><td>${h(m.email)}</td><td>${h(m.display_name)}</td><td>${h(m.site)}</td><td>${m.sent_today}</td><td>${Math.min(m.daily_cap, cfg.mailboxDailyCap)}</td>
<td>${m.enabled ? '<span class="ok">enabled</span>' : '<span class="bad">disabled</span>'}${m.last_error ? ` <span class="bad" title="${h(m.last_error)}">⚠ ${h(m.last_error.slice(0, 60))} (${fmt(m.last_error_at)})</span>` : ""}</td></tr>`).join("")}
</table>
<h2>Last 14 days</h2>
<table><tr><th>Day</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Replied</th></tr>
${daily.map(d => `<tr><td>${d.day}</td><td>${d.sent}</td><td>${d.opened}</td><td>${d.clicked}</td><td>${d.replied}</td></tr>`).join("") || "<tr><td colspan=5 class=muted>No sends yet</td></tr>"}</table>`;
  res.send(page("Dashboard", body, flashOf(req)));
});

admin.post("/toggle-pause", async (req, res) => {
  const paused = (await getSetting("paused", "false")) === "true";
  await setSetting("paused", paused ? "false" : "true");
  redirect(res, "/admin", paused ? "Sending resumed" : "Sending paused");
});

// ---- campaigns ---------------------------------------------------------------
admin.get("/campaigns", async (req, res) => {
  const camps = await all(`
    SELECT c.*, (SELECT count(*) FROM steps s WHERE s.campaign_id=c.id)::int AS steps,
           (SELECT count(*) FROM enrolments e WHERE e.campaign_id=c.id)::int AS enrolled,
           (SELECT count(*) FROM enrolments e WHERE e.campaign_id=c.id AND e.status='active')::int AS active,
           (SELECT count(*) FROM sends s WHERE s.campaign_id=c.id AND s.status<>'failed')::int AS sent,
           (SELECT count(*) FROM sends s WHERE s.campaign_id=c.id AND s.replied_at IS NOT NULL)::int AS replied
      FROM campaigns c ORDER BY c.id DESC`);
  const body = `<h1>Campaigns</h1>
<table><tr><th>ID</th><th>Name</th><th>Site</th><th>Status</th><th>Steps</th><th>Enrolled</th><th>Queued</th><th>Sent</th><th>Replied</th><th></th></tr>
${camps.map(c => `<tr><td>${c.id}</td><td><a href="/admin/campaigns/${c.id}">${h(c.name)}</a>${c.instantly_id ? ' <small class=muted>(from Instantly)</small>' : ""}</td><td>${h(c.site)}</td>
<td class="${c.status === "active" ? "ok" : "muted"}">${c.status}</td><td>${c.steps}</td><td>${c.enrolled}</td><td>${c.active}</td><td>${c.sent}</td><td>${c.replied}</td>
<td><form class="inline" method="post" action="/admin/campaigns/${c.id}/status"><input type="hidden" name="status" value="${c.status === "active" ? "paused" : "active"}"><button class="sec">${c.status === "active" ? "Pause" : "Activate"}</button></form></td></tr>`).join("")}
</table>
<h2>New campaign</h2>
<div class="box"><form method="post" action="/admin/campaigns">
<div class="row"><div><label>Name</label><input type="text" name="name" required placeholder="Market Watcher – GM Clean – Nov 2026"></div>
<div><label>Site (which domain's mailboxes + landing page)</label><select name="site">${Object.entries(SITES).map(([k, s]) => `<option value="${k}">${h(s.label)} (${k})</option>`).join("")}</select></div></div>
<label>Step 1 subject</label><input type="text" name="subject" required>
<label>Step 1 preview text (preheader)</label><input type="text" name="preheader">
<label>Step 1 body <small>— plain text with blank lines between paragraphs, or HTML. Merge fields: {{first_name|there}} {{last_name}} {{company}} {{site_url}} {{sender_name}}</small></label>
<textarea name="body" required></textarea>
<p><button>Create (paused)</button></p></form></div>`;
  res.send(page("Campaigns", body, flashOf(req)));
});

admin.post("/campaigns", async (req, res) => {
  const { name, site, subject, body } = req.body;
  if (!SITES[site]) return redirect(res, "/admin/campaigns", "Error: unknown site");
  const c = await one("INSERT INTO campaigns(name,site,status) VALUES($1,$2,'paused') RETURNING id", [name.trim(), site]);
  await q("INSERT INTO steps(campaign_id,position,delay_days,subject,preheader,body_html) VALUES($1,1,0,$2,$3,$4)", [c.id, subject.trim(), (req.body.preheader || "").trim(), body]);
  redirect(res, `/admin/campaigns/${c.id}`, "Campaign created (paused). Add steps and enrol contacts, then activate.");
});

admin.post("/campaigns/:id/status", async (req, res) => {
  const status = ["active", "paused", "finished"].includes(req.body.status) ? req.body.status : "paused";
  await q("UPDATE campaigns SET status=$2 WHERE id=$1", [req.params.id, status]);
  redirect(res, "/admin/campaigns", `Campaign ${req.params.id} is now ${status}`);
});

admin.get("/campaigns/:id", async (req, res) => {
  const c = await one("SELECT * FROM campaigns WHERE id=$1", [req.params.id]);
  if (!c) return res.status(404).send("not found");
  const steps = await all("SELECT * FROM steps WHERE campaign_id=$1 ORDER BY position", [c.id]);
  const stats = await all(`
    SELECT s.step_position, count(*)::int AS sent, count(s.opened_at)::int AS opened, count(s.clicked_at)::int AS clicked, count(s.replied_at)::int AS replied
      FROM sends s WHERE s.campaign_id=$1 AND s.status<>'failed' GROUP BY 1 ORDER BY 1`, [c.id]);
  const enrol = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active,
     count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='stopped')::int AS stopped FROM enrolments WHERE campaign_id=$1`, [c.id]);
  const sources = await all(`SELECT data_source, count(*)::int AS n, count(*) FILTER (WHERE status='active' AND NOT instantly_contacted)::int AS fresh,
     count(*) FILTER (WHERE status='active')::int AS active FROM contacts GROUP BY 1 ORDER BY 2 DESC`);
  const sampleVars = { first_name: "Jane", last_name: "Smith", company: "Acme Ltd", site_url: SITES[c.site]?.url, site_name: SITES[c.site]?.label, sender_name: "James Whitfield", sender_first_name: "James" };
  const body = `<h1>${h(c.name)} <small class="muted">#${c.id} · ${h(c.site)} · ${c.status}</small></h1>
<div class="cards"><div class="card"><b>${enrol.total}</b><span>enrolled</span></div><div class="card"><b>${enrol.active}</b><span>queued</span></div><div class="card"><b>${enrol.completed}</b><span>completed</span></div><div class="card"><b>${enrol.stopped}</b><span>stopped (reply/bounce/unsub)</span></div></div>
<form class="inline" method="post" action="/admin/campaigns/${c.id}/status"><input type="hidden" name="status" value="${c.status === "active" ? "paused" : "active"}"><button>${c.status === "active" ? "Pause campaign" : "Activate campaign"}</button></form>
<form class="inline" method="post" action="/admin/campaigns/${c.id}/test" style="margin-left:12px"><input type="text" name="to" value="${h(await getSetting("test_recipients", "rob@revio.agency"))}" style="width:260px;display:inline-block" title="comma-separated"> <label style="display:inline"><input type="checkbox" name="realistic" value="1"> realistic (step 1 only, no [TEST] prefix)</label> <button class="sec">Send to these test recipients</button></form>

<h2>Steps</h2>
${steps.map(s => `<div class="box"><form method="post" action="/admin/steps/${s.id}">
<div class="row"><div><label>Step ${s.position} subject <small>(leave blank on follow-ups to send as "Re: step 1 subject")</small></label><input type="text" name="subject" value="${h(s.subject)}"></div>
<div><label>Delay (days after previous step)</label><input type="number" name="delay_days" value="${s.delay_days}" min="0" ${s.position === 1 ? "disabled" : ""}></div></div>
<label>Preview text (preheader) <small>— shown next to the subject in the inbox; ~80 characters</small></label><input type="text" name="preheader" value="${h(s.preheader || "")}">
<label>Body</label><textarea name="body">${h(s.body_html)}</textarea>
<p><button>Save step</button> <button class="sec" formaction="/admin/steps/${s.id}/delete" formmethod="post" onclick="return confirm('Delete step ${s.position}?')">Delete</button></p>
<details><summary>Preview with sample data</summary><div style="border:1px solid #e3e6ea;padding:14px;margin-top:8px;font-family:Georgia,serif">${merge(toHtml(s.body_html), sampleVars)}</div></details>
</form></div>`).join("")}
<div class="box"><form method="post" action="/admin/campaigns/${c.id}/steps"><h3 style="margin:0 0 6px">Add follow-up step ${steps.length + 1}</h3>
<div class="row"><div><label>Subject (blank = Re: step 1)</label><input type="text" name="subject"></div><div><label>Delay days</label><input type="number" name="delay_days" value="4" min="1"></div></div>
<label>Preview text (preheader)</label><input type="text" name="preheader">
<label>Body</label><textarea name="body" placeholder="Hi {{first_name|there}},&#10;&#10;Just making sure this reached you…"></textarea><p><button>Add step</button></p></form></div>

<h2>Results by step</h2>
<table><tr><th>Step</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Replied</th></tr>${stats.map(s => `<tr><td>${s.step_position}</td><td>${s.sent}</td><td>${s.opened}</td><td>${s.clicked}</td><td>${s.replied}</td></tr>`).join("") || "<tr><td colspan=5 class=muted>Nothing sent yet</td></tr>"}</table>

<h2>Enrol contacts</h2>
<div class="box"><form method="post" action="/admin/campaigns/${c.id}/enrol">
<div class="row"><div><label>Data source</label><select name="data_source"><option value="">— any —</option>${sources.map(s => `<option value="${h(s.data_source || "")}">${h(s.data_source || "(blank)")} — ${s.fresh} fresh / ${s.active} active / ${s.n} total</option>`).join("")}</select></div>
<div><label>Max contacts to enrol (blank = all matching)</label><input type="number" name="limit" min="1" placeholder="e.g. 20000"></div></div>
<label><input type="checkbox" name="skip_instantly" value="1" checked> Skip contacts already emailed by Instantly</label>
<label><input type="checkbox" name="skip_other" value="1" checked> Skip contacts already enrolled in any other campaign</label>
<label>Split between brands: <select name="split" style="width:auto;display:inline-block"><option value="">no split – take every matching contact</option><option value="even">this campaign takes every 2nd contact (even ids)</option><option value="odd">this campaign takes the other half (odd ids)</option></select> <small>Use "even" on one brand's campaign and "odd" on the other for a 50/50 split of the same list.</small></label>
<p><button>Enrol</button> <small>Only status=active contacts not on the suppression list are enrolled. Sending starts when the campaign is active.</small></p></form></div>`;
  res.send(page(c.name, body, flashOf(req)));
});

admin.post("/campaigns/:id/steps", async (req, res) => {
  const pos = (await one("SELECT COALESCE(max(position),0)+1 AS p FROM steps WHERE campaign_id=$1", [req.params.id])).p;
  await q("INSERT INTO steps(campaign_id,position,delay_days,subject,preheader,body_html) VALUES($1,$2,$3,$4,$5,$6)",
    [req.params.id, pos, Math.max(1, Number(req.body.delay_days) || 1), (req.body.subject || "").trim(), (req.body.preheader || "").trim(), req.body.body || ""]);
  redirect(res, `/admin/campaigns/${req.params.id}`, `Step ${pos} added`);
});
admin.post("/steps/:id", async (req, res) => {
  const s = await one("SELECT * FROM steps WHERE id=$1", [req.params.id]);
  await q("UPDATE steps SET subject=$2, body_html=$3, delay_days=$4, preheader=$5 WHERE id=$1",
    [s.id, (req.body.subject || "").trim(), req.body.body || "", s.position === 1 ? 0 : Math.max(1, Number(req.body.delay_days) || 1), (req.body.preheader || "").trim()]);
  redirect(res, `/admin/campaigns/${s.campaign_id}`, `Step ${s.position} saved`);
});
admin.post("/steps/:id/delete", async (req, res) => {
  const s = await one("SELECT * FROM steps WHERE id=$1", [req.params.id]);
  await q("DELETE FROM steps WHERE id=$1", [s.id]);
  await q("UPDATE steps SET position = position - 1 WHERE campaign_id=$1 AND position > $2", [s.campaign_id, s.position]);
  redirect(res, `/admin/campaigns/${s.campaign_id}`, "Step deleted");
});

admin.post("/campaigns/:id/enrol", async (req, res) => {
  const c = await one("SELECT * FROM campaigns WHERE id=$1", [req.params.id]);
  const params = [c.id];
  const where = ["ct.status='active'", "NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=ct.email)",
    "NOT EXISTS (SELECT 1 FROM enrolments e WHERE e.contact_id=ct.id AND e.campaign_id=$1)"];
  if (req.body.data_source) { params.push(req.body.data_source); where.push(`ct.data_source=$${params.length}`); }
  if (req.body.skip_instantly) where.push("NOT ct.instantly_contacted");
  if (req.body.skip_other) where.push("NOT EXISTS (SELECT 1 FROM enrolments e2 WHERE e2.contact_id=ct.id)");
  if (req.body.split === "even") where.push("ct.id % 2 = 0");
  if (req.body.split === "odd") where.push("ct.id % 2 = 1");
  let limit = "";
  if (req.body.limit) { params.push(Number(req.body.limit)); limit = `LIMIT $${params.length}`; }
  const r = await q(`
    INSERT INTO enrolments(campaign_id, contact_id, next_due_at)
    SELECT $1, ct.id, now() FROM contacts ct WHERE ${where.join(" AND ")} ORDER BY ct.id ${limit}
    ON CONFLICT DO NOTHING`, params);
  redirect(res, `/admin/campaigns/${c.id}`, `Enrolled ${r.rowCount} contacts`);
});

admin.post("/campaigns/:id/test", async (req, res) => {
  const c = await one("SELECT * FROM campaigns WHERE id=$1", [req.params.id]);
  const realistic = !!req.body.realistic;
  let steps = await all("SELECT * FROM steps WHERE campaign_id=$1 ORDER BY position", [c.id]);
  if (realistic) steps = steps.slice(0, 1);
  const mailbox = await one("SELECT * FROM mailboxes WHERE site=$1 AND enabled AND smtp_pass IS NOT NULL AND smtp_pass<>'' ORDER BY random() LIMIT 1", [c.site]);
  const recipients = String(req.body.to || "").split(/[\s,;]+/).map(s => s.trim()).filter(s => s.includes("@"));
  if (recipients.length) await setSetting("test_recipients", recipients.join(", "));
  if (!mailbox) return redirect(res, `/admin/campaigns/${c.id}`, "Error: no enabled mailbox with a password for this site yet");
  if (!recipients.length) return redirect(res, `/admin/campaigns/${c.id}`, "Error: enter at least one recipient");
  try {
    const { buildEmail, contactVars } = await import("./templates.js");
    const { sendMail } = await import("./mailer.js");
    let n = 0;
    for (const to of recipients) {
      const contact = { email: to, first_name: "Rob", last_name: "Test", company: "Example Ltd" };
      const vars = contactVars(contact, mailbox, c.site);
      let threadId = null, threadSubject = null;
      for (const step of steps) {
        const built = buildEmail({ step, contact, mailbox, site: c.site, token: "test", vars });
        const subject = step.position > 1 && !step.subject.trim() && threadSubject ? `Re: ${threadSubject}` : built.subject;
        const { messageId } = await sendMail({ mailbox, to, subject: realistic ? subject : `[TEST step ${step.position}/${steps.length}] ${subject}`, html: built.html, text: built.text, unsubUrl: built.unsubUrl, inReplyTo: step.position > 1 && step.reply_in_thread ? threadId : undefined });
        if (step.position === 1) { threadId = messageId; threadSubject = built.subject; }
        n++;
      }
    }
    redirect(res, `/admin/campaigns/${c.id}`, `Sent ${n} test email(s) from ${mailbox.email} to ${recipients.join(", ")}`);
  } catch (e) { redirect(res, `/admin/campaigns/${c.id}`, `Failed: ${e.message}`); }
});

// ---- stats ------------------------------------------------------------------
const STATS_SQL = (groupCols, joins, where) => `
  SELECT ${groupCols},
         count(s.id)::int                                             AS sent,
         count(s.id) FILTER (WHERE s.status='bounced')::int           AS bounced,
         count(s.id) FILTER (WHERE s.status='bounced' AND s.bounce_type='hard')::int AS hard,
         count(s.id) FILTER (WHERE s.status='bounced' AND s.bounce_type='soft')::int AS soft,
         count(s.id) FILTER (WHERE s.opened_at IS NOT NULL)::int      AS opened,
         count(s.id) FILTER (WHERE s.clicked_at IS NOT NULL)::int     AS clicked,
         count(s.id) FILTER (WHERE s.replied_at IS NOT NULL)::int     AS replied,
         count(u.contact_id)::int                                     AS unsubscribed,
         count(cv.id)::int                                            AS converted
    FROM sends s
    ${joins}
    LEFT JOIN LATERAL (SELECT e.contact_id FROM events e WHERE e.type='unsubscribe' AND e.send_id=s.id LIMIT 1) u ON true
    LEFT JOIN contacts cv ON cv.id = s.contact_id AND cv.converted_at IS NOT NULL AND cv.converted_at >= s.sent_at
      AND NOT EXISTS (SELECT 1 FROM sends s2 WHERE s2.contact_id = s.contact_id AND s2.sent_at > s.sent_at AND s2.sent_at <= cv.converted_at)
   WHERE s.status <> 'failed' ${where}
   GROUP BY ${groupCols.replace(/ AS \w+/g, "")} ORDER BY 1, 2`;

function statsTable(rows, labelCols) {
  const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : "–";
  return `<table><tr>${labelCols.map(c => `<th>${h(c)}</th>`).join("")}<th>Sent</th><th>Delivered</th><th>Bounces</th><th>Bounce rate</th><th>Hard / Soft</th><th>Opens</th><th>Open rate</th><th>Clicks</th><th>CTR</th><th>Click-to-open</th><th>Replies</th><th>Reply rate</th><th>Unsubs</th><th>Conversions</th><th>Conv. rate</th></tr>
${rows.map(r => { const d = r.sent - r.bounced; return `<tr>${labelCols.map((_, i) => `<td>${h(String(Object.values(r)[i] ?? ""))}</td>`).join("")}
<td>${r.sent}</td><td>${d}</td><td>${r.bounced}</td><td>${pct(r.bounced, r.sent)}</td><td>${r.hard} / ${r.soft}</td><td>${r.opened}</td><td>${pct(r.opened, d)}</td><td>${r.clicked}</td><td>${pct(r.clicked, d)}</td><td>${pct(r.clicked, r.opened)}</td><td>${r.replied}</td><td>${pct(r.replied, d)}</td><td>${r.unsubscribed}</td><td>${r.converted}</td><td>${pct(r.converted, d)}</td></tr>`; }).join("") || `<tr><td colspan="${labelCols.length + 15}" class="muted">Nothing sent yet</td></tr>`}</table>`;
}

admin.get("/stats", async (req, res) => {
  const byCampaign = await all(STATS_SQL("c.name AS campaign", "JOIN campaigns c ON c.id = s.campaign_id", ""));
  const byStep = await all(STATS_SQL("c.name AS campaign, s.step_position AS step", "JOIN campaigns c ON c.id = s.campaign_id", ""));
  const byDomain = await all(STATS_SQL("m.domain AS domain", "JOIN mailboxes m ON m.id = s.mailbox_id", ""));
  const byMailbox = await all(STATS_SQL("m.email AS mailbox", "JOIN mailboxes m ON m.id = s.mailbox_id", ""));
  const bySource = await all(STATS_SQL("ct.data_source AS data_source", "JOIN contacts ct ON ct.id = s.contact_id", ""));
  const byDay = await all(STATS_SQL(`to_char(s.sent_at AT TIME ZONE '${cfg.tz}', 'YYYY-MM-DD') AS day`, "", "AND s.sent_at > now() - interval '30 days'"));
  const bounceReasons = await all(`SELECT COALESCE(bounce_type,'?') AS type, left(error, 90) AS reason, count(*)::int n FROM sends WHERE status='bounced' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`);
  const conv = await all(`SELECT ct.email, ct.first_name, ct.last_name, ct.converted_at, ct.conversion_event, cp.name AS campaign
      FROM contacts ct LEFT JOIN LATERAL (SELECT s.campaign_id FROM sends s WHERE s.contact_id=ct.id ORDER BY s.sent_at LIMIT 1) f ON true
      LEFT JOIN campaigns cp ON cp.id = f.campaign_id WHERE ct.converted_at IS NOT NULL ORDER BY ct.converted_at DESC LIMIT 100`);
  const body = `<h1>Stats</h1>
<p><small>Opens are inflated by Apple Mail privacy and corporate link scanners; clicks within 20 seconds of delivery and known scanner user-agents are ignored. Rates are against delivered (sent minus bounced). Conversions = HubSpot form submissions (either landing page) made after our email to that person, refreshed hourly. ${h(convState.lastResult || "")}</small>
<form class="inline" method="post" action="/admin/stats/sync-conversions"><button class="sec">Refresh conversions now</button></form></p>
<h2>By campaign</h2>${statsTable(byCampaign, ["Campaign"])}
<h2>By step</h2>${statsTable(byStep, ["Campaign", "Step"])}
<h2>By sending domain</h2>${statsTable(byDomain, ["Domain"])}
<h2>By data source</h2>${statsTable(bySource, ["Data source"])}
<h2>Last 30 days</h2>${statsTable(byDay.reverse(), ["Day"])}
<h2>By mailbox</h2>${statsTable(byMailbox, ["Mailbox"])}
<h2>Bounce reasons</h2><table><tr><th>Type</th><th>Reason</th><th>Count</th></tr>${bounceReasons.map(b => `<tr><td>${h(b.type)}</td><td>${h(b.reason || "")}</td><td>${b.n}</td></tr>`).join("") || "<tr><td colspan=3 class=muted>No bounces</td></tr>"}</table>
<h2>Conversions (form fills)</h2><table><tr><th>When</th><th>Contact</th><th>Form</th><th>First campaign</th></tr>${conv.map(c => `<tr><td>${fmt(c.converted_at)}</td><td>${h(c.first_name || "")} ${h(c.last_name || "")}<br><small>${h(c.email)}</small></td><td>${h(c.conversion_event || "")}</td><td>${h(c.campaign || "")}</td></tr>`).join("") || "<tr><td colspan=4 class=muted>None yet</td></tr>"}</table>`;
  res.send(page("Stats", body, flashOf(req)));
});
admin.post("/stats/sync-conversions", async (req, res) => {
  try { await syncConversions(); redirect(res, "/admin/stats", convState.lastResult); }
  catch (e) { redirect(res, "/admin/stats", `Failed: ${e.message}`); }
});

// ---- HubSpot call-back reminders ----------------------------------------------
admin.get("/callbacks", async (req, res) => {
  const events = await recentEvents(150);
  const owners = {};
  const body = `<h1>HubSpot call-back reminders <small class="muted">(replaces the AWS "Call Reminder" app)</small></h1>
<div class="cards">
  <div class="card"><b class="${cbState.enabled ? "ok" : "bad"}">${cbState.enabled ? "LIVE" : "OBSERVING"}</b><span>${cbState.enabled ? "setting Reminder Trigger / Call Back Not Made Trigger in HubSpot" : "watching only – nothing written to HubSpot"}${cbState.dry ? " (dry run)" : ""}</span></div>
  <div class="card"><b>${cbState.today.length}</b><span>call-backs today + yesterday</span></div>
  <div class="card"><b>${h(cfg.tz)}</b><span>timezone (BST/GMT automatic) · last tick ${fmt(cbState.lastTick)}</span></div>
</div>
<p><small>${h(cbState.lastResult || "not run yet")}</small></p>
<form class="inline" method="post" action="/admin/callbacks/toggle"><button class="${cbState.enabled ? "danger" : ""}">${cbState.enabled ? "Switch to observing only" : "Go live (write to HubSpot)"}</button></form>
<form class="inline" method="post" action="/admin/callbacks/tick" style="margin-left:10px"><button class="sec">Run a check now</button></form>
<h2>Schedule</h2>
<table><tr><th>Call-back (London)</th><th>Contact</th><th>Owner id</th><th>Status</th></tr>
${cbState.today.map(c => `<tr><td>${c.date} ${h(c.time)}${c.due ? ` <small class="muted">(${fmt(c.due)})</small>` : ""}</td><td>${h(c.email || "")} <small class="muted">#${c.id}</small></td><td>${h(c.owner || "")}</td><td>${h(c.status)}</td></tr>`).join("") || "<tr><td colspan=4 class=muted>Nothing scheduled</td></tr>"}</table>
<h2>Recent actions</h2>
<table><tr><th>When</th><th>Kind</th><th>Contact</th><th>Call-back date</th><th>Detail</th></tr>
${events.map(e => `<tr><td>${fmt(e.created_at)}</td><td>${h(e.kind)}</td><td>${h(e.email || "")} <small class="muted">#${h(e.contact_id)}</small></td><td>${h(e.callback_date)}</td><td>${h(e.detail || "")}</td></tr>`).join("") || "<tr><td colspan=5 class=muted>None yet</td></tr>"}</table>`;
  res.send(page("Call-backs", body, flashOf(req)));
});
admin.post("/callbacks/toggle", async (req, res) => {
  await setSetting("callbacks_enabled", cbState.enabled ? "false" : "true");
  await callbackTick();
  redirect(res, "/admin/callbacks", cbState.enabled ? "Call-back reminders are LIVE" : "Call-back reminders set to observing only");
});
admin.post("/callbacks/tick", async (req, res) => { await callbackTick(); redirect(res, "/admin/callbacks", cbState.lastResult); });

// ---- contacts ----------------------------------------------------------------
admin.get("/contacts", async (req, res) => {
  const bySource = await all(`SELECT data_source, count(*)::int AS n,
      count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE instantly_contacted)::int AS instantly,
      count(*) FILTER (WHERE status='replied')::int AS replied, count(*) FILTER (WHERE status='bounced')::int AS bounced, count(*) FILTER (WHERE status='unsubscribed')::int AS unsub
      FROM contacts GROUP BY 1 ORDER BY 2 DESC`);
  const search = String(req.query.q || "").trim().toLowerCase();
  const found = search ? await all(`SELECT c.*, (SELECT count(*) FROM sends s WHERE s.contact_id=c.id)::int AS sends FROM contacts c WHERE c.email LIKE $1 OR lower(c.last_name)=$2 ORDER BY c.id LIMIT 50`, [`%${search}%`, search]) : [];
  const body = `<h1>Contacts</h1>
<table><tr><th>Data source</th><th>Total</th><th>Active</th><th>Already emailed by Instantly</th><th>Replied</th><th>Bounced</th><th>Unsubscribed</th></tr>
${bySource.map(s => `<tr><td>${h(s.data_source || "(blank)")}</td><td>${s.n}</td><td>${s.active}</td><td>${s.instantly}</td><td>${s.replied}</td><td>${s.bounced}</td><td>${s.unsub}</td></tr>`).join("")}</table>
<h2>Upload a spreadsheet</h2>
<div class="box"><form method="post" action="/admin/contacts/upload" enctype="multipart/form-data">
<label>CSV or XLSX</label><input type="file" name="file" accept=".csv,.xlsx,.xls" required>
<div class="row"><div><label>Data source label <small>(blank = use the file's own column, else the file name)</small></label><input type="text" name="data_source"></div>
<div><label>Site <small>(optional default brand for these contacts)</small></label><select name="site"><option value="">—</option>${Object.keys(SITES).map(k => `<option value="${k}">${k}</option>`).join("")}</select></div></div>
<p><button>Import</button> <small>Headers are detected automatically (email, first/last name, phone, company, postcode, data source). Files without a header row work too.</small></p></form></div>
<h2>Suppress addresses</h2>
<div class="box"><form method="post" action="/admin/contacts/suppress"><label>One email per line</label><textarea name="emails" style="min-height:80px"></textarea><p><button class="danger">Add to suppression list</button></p></form></div>
<h2>Find a contact</h2>
<form method="get"><input type="text" name="q" value="${h(search)}" placeholder="email or surname" style="width:300px;display:inline-block"> <button class="sec">Search</button></form>
${found.length ? `<table style="margin-top:10px"><tr><th>Email</th><th>Name</th><th>Phone</th><th>Source</th><th>Status</th><th>Instantly</th><th>Sends</th></tr>${found.map(c => `<tr><td>${h(c.email)}</td><td>${h(c.first_name || "")} ${h(c.last_name || "")}</td><td>${h(c.phone || "")}</td><td>${h(c.data_source || "")}</td><td>${c.status}</td><td>${c.instantly_contacted ? h(c.instantly_status || "yes") : ""}</td><td>${c.sends}</td></tr>`).join("")}</table>` : ""}`;
  res.send(page("Contacts", body, flashOf(req)));
});

admin.post("/contacts/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return redirect(res, "/admin/contacts", "Error: no file");
  try {
    const r = await importFile(req.file.originalname, { site: req.body.site || null, dataSource: req.body.data_source || "" }, req.file.buffer);
    redirect(res, "/admin/contacts", `${r.file}: ${r.rows} rows, ${r.valid} valid emails, ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped`);
  } catch (e) { redirect(res, "/admin/contacts", `Error: ${e.message}`); }
});

admin.post("/contacts/suppress", async (req, res) => {
  const emails = String(req.body.emails || "").split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes("@"));
  for (const e of emails) {
    await q("INSERT INTO suppressions(email,reason) VALUES($1,'manual') ON CONFLICT DO NOTHING", [e]);
    await q("UPDATE contacts SET status='suppressed' WHERE email=$1 AND status='active'", [e]);
    await q("UPDATE enrolments SET status='stopped', stop_reason='suppressed' WHERE status='active' AND contact_id IN (SELECT id FROM contacts WHERE email=$1)", [e]);
  }
  redirect(res, "/admin/contacts", `Suppressed ${emails.length} address(es)`);
});

// ---- mailboxes ---------------------------------------------------------------
admin.get("/mailboxes", async (req, res) => {
  const { perMailbox } = await todaysCounts();
  const withPass = await all("SELECT id, (smtp_pass IS NOT NULL AND smtp_pass<>'') AS has_pass, warmup_from FROM mailboxes");
  const hp = Object.fromEntries(withPass.map(r => [r.id, r.has_pass]));
  const wf = Object.fromEntries(withPass.map(r => [r.id, r.warmup_from ? new Date(r.warmup_from).toISOString().slice(0, 10) : ""]));
  const { allowances: al, total: dayTotal } = await allowances();
  const wcap = (id) => { const c = warmupCap({ warmup_from: wf[id] || null }); return c === Infinity ? "" : c; };
  const body = `<h1>Mailboxes</h1>
<p><small>SMTP ${h(cfg.smtp.host)}:${cfg.smtp.port}. Global per-mailbox cap ${cfg.mailboxDailyCap}/day; today's total ${dayTotal} is shared out so warm-up boxes take only their limit and the rest covers the remainder. Warm-up from a date: week 1 = 5/day, week 2 = 10, week 3 = 20, week 4 = 30, then off. Passwords are stored in the database, never shown.</small></p>
<table><tr><th>Email</th><th>Display name</th><th>Site</th><th>Cap</th><th>Warm-up from</th><th>Allowed today</th><th>Today</th><th>Password</th><th>Enabled</th><th>Last error</th><th></th></tr>
${perMailbox.map(m => `<tr><form method="post" action="/admin/mailboxes/${m.id}">
<td>${h(m.email)}</td><td><input type="text" name="display_name" value="${h(m.display_name)}"></td>
<td><select name="site">${Object.keys(SITES).map(k => `<option ${k === m.site ? "selected" : ""}>${k}</option>`).join("")}</select></td>
<td><input type="number" name="daily_cap" value="${m.daily_cap}" min="0" style="width:70px"></td>
<td><input type="date" name="warmup_from" value="${wf[m.id]}" style="width:140px">${wcap(m.id) !== "" ? ` <small class="muted">${wcap(m.id)}/day</small>` : ""}</td>
<td>${al.get(m.id) ?? '<span class="muted">—</span>'}</td><td>${m.sent_today}</td>
<td>${hp[m.id] ? '<span class="ok">set</span>' : '<span class="bad">missing</span>'} <input type="password" name="smtp_pass" placeholder="new password" autocomplete="new-password" style="width:130px;display:inline-block"></td>
<td><input type="checkbox" name="enabled" value="1" ${m.enabled ? "checked" : ""}></td>
<td class="bad" style="max-width:220px;font-size:12px">${m.last_error ? h(m.last_error.slice(0, 120)) : ""}</td>
<td style="white-space:nowrap"><button class="sec">Save</button> <button formaction="/admin/mailboxes/${m.id}/verify" class="sec">Test login</button></td></form></tr>`).join("")}
</table>
<h2>Add mailbox</h2><div class="box"><form method="post" action="/admin/mailboxes">
<div class="row"><div><label>Email</label><input type="text" name="email" required></div><div><label>Display name</label><input type="text" name="display_name" required></div></div>
<div class="row"><div><label>Site</label><select name="site">${Object.keys(SITES).map(k => `<option>${k}</option>`).join("")}</select></div><div><label>SMTP password</label><input type="password" name="smtp_pass" autocomplete="new-password"></div></div>
<p><button>Add</button></p></form></div>`;
  res.send(page("Mailboxes", body, flashOf(req)));
});
admin.post("/mailboxes", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  await q("INSERT INTO mailboxes(email,display_name,domain,site,smtp_pass) VALUES($1,$2,$3,$4,NULLIF($5,'')) ON CONFLICT(email) DO NOTHING",
    [email, req.body.display_name.trim(), email.split("@")[1], req.body.site, req.body.smtp_pass || ""]);
  redirect(res, "/admin/mailboxes", `Added ${email}`);
});
admin.post("/mailboxes/:id", async (req, res) => {
  await q(`UPDATE mailboxes SET display_name=$2, site=$3, daily_cap=$4, enabled=$5, last_error = CASE WHEN $5 THEN NULL ELSE last_error END,
           smtp_pass = CASE WHEN $6<>'' THEN $6 ELSE smtp_pass END, warmup_from = NULLIF($7,'')::date WHERE id=$1`,
    [req.params.id, req.body.display_name.trim(), req.body.site, Number(req.body.daily_cap) || 0, !!req.body.enabled, req.body.smtp_pass || "", String(req.body.warmup_from || "").trim()]);
  redirect(res, "/admin/mailboxes", "Saved");
});
admin.post("/mailboxes/:id/verify", async (req, res) => {
  const m = await one("SELECT * FROM mailboxes WHERE id=$1", [req.params.id]);
  try { await verifyMailbox(m); await q("UPDATE mailboxes SET last_error=NULL WHERE id=$1", [m.id]); redirect(res, "/admin/mailboxes", `${m.email}: SMTP login OK`); }
  catch (e) { await q("UPDATE mailboxes SET last_error=$2, last_error_at=now() WHERE id=$1", [m.id, e.message.slice(0, 500)]); redirect(res, "/admin/mailboxes", `Failed: ${m.email}: ${e.message}`); }
});

// ---- replies -----------------------------------------------------------------
admin.get("/replies", async (req, res) => {
  const rows = await recentReplies(200);
  const body = `<h1>Replies &amp; bounces</h1>
<form method="post" action="/admin/replies/poll" class="inline"><button class="sec">Check inbox now</button></form> <small>${h(replyState.lastResult || "")} · last ${fmt(replyState.lastPoll)}</small>
<table style="margin-top:12px"><tr><th>When</th><th>Type</th><th>From</th><th>Contact</th><th>Campaign</th><th>To mailbox</th><th>Subject</th><th>Snippet</th></tr>
${rows.map(r => `<tr><td style="white-space:nowrap">${fmt(r.received_at)}</td><td class="${r.is_bounce ? "bad" : "ok"}">${r.is_bounce ? "bounce" : "reply"}</td><td>${h(r.from_email || "")}</td><td>${h(r.first_name || "")} ${h(r.last_name || "")}<br><small>${h(r.email)}</small></td><td>${h(r.campaign_name || "")}</td><td>${h(r.mailbox_email || "")}</td><td>${h(r.subject || "")}</td><td style="max-width:360px;font-size:12px">${h((r.snippet || "").slice(0, 300))}</td></tr>`).join("") || "<tr><td colspan=8 class=muted>None yet</td></tr>"}</table>`;
  res.send(page("Replies", body, flashOf(req)));
});
admin.post("/replies/poll", async (req, res) => {
  try { await pollReplies(); redirect(res, "/admin/replies", replyState.lastResult); }
  catch (e) { redirect(res, "/admin/replies", `Failed: ${e.message}`); }
});

// ---- settings ----------------------------------------------------------------
admin.get("/settings", async (req, res) => {
  const dailyTotal = await getSetting("daily_total", cfg.dailyTotal);
  const ramp = await effectiveDailyTotal();
  const g = async (k, d) => h(await getSetting(k, d));
  const body = `<h1>Settings</h1><div class="box"><form method="post" action="/admin/settings">
<p><b>Today's effective limit: ${ramp.total}/day</b> — ${h(ramp.phase)}${ramp.day ? `, day ${ramp.day} since first send (${await g("ramp_started_on", "")})` : " (ramp starts on the first send)"}</p>
<div class="row"><div><label>Target daily total</label><input type="number" name="daily_total" value="${h(dailyTotal)}" min="0"></div>
<div><label>Ramp: starting total per day</label><input type="number" name="ramp_start_total" value="${await g("ramp_start_total", 300)}" min="0"></div></div>
<div class="row"><div><label>Ramp: hold at starting total for (days)</label><input type="number" name="ramp_hold_days" value="${await g("ramp_hold_days", 7)}" min="0"></div>
<div><label>Ramp: increase per day after the hold</label><input type="number" name="ramp_step" value="${await g("ramp_step", 100)}" min="1"></div></div>
<label>Ramp start date (YYYY-MM-DD, blank = set automatically on first send)</label><input type="text" name="ramp_started_on" value="${await g("ramp_started_on", "")}" style="width:200px">
<p><button>Save</button></p></form></div>
<div class="box"><b>From environment</b><pre>send window   ${cfg.windowStart}–${cfg.windowEnd} ${cfg.tz}, days ${cfg.sendDays.join(",")}
mailbox cap   ${cfg.mailboxDailyCap}/day
SMTP          ${cfg.smtp.host}:${cfg.smtp.port}
IMAP          ${cfg.imap.host || "(not set)"}:${cfg.imap.port} as ${cfg.imap.user || "(not set)"} every ${cfg.imap.pollMinutes} min
HubSpot       ${cfg.hubspot.enabled && cfg.hubspot.token ? "enabled" : "disabled"}
Base URL      ${cfg.baseUrl}
Tracking URLs ${Object.entries(SITES).map(([k, s]) => `${k}=${s.trackUrl}`).join("  ")}
Track step 1  ${cfg.trackStep1 ? "yes" : "no (plain 1:1 first touch)"}</pre><small>Change these in Render → Environment; the service restarts automatically.</small></div>`;
  res.send(page("Settings", body, flashOf(req)));
});
admin.post("/settings", async (req, res) => {
  await setSetting("daily_total", Math.max(0, Number(req.body.daily_total) || 0));
  await setSetting("ramp_start_total", Math.max(0, Number(req.body.ramp_start_total) || 0));
  await setSetting("ramp_hold_days", Math.max(0, Number(req.body.ramp_hold_days) || 0));
  await setSetting("ramp_step", Math.max(1, Number(req.body.ramp_step) || 1));
  const d = String(req.body.ramp_started_on || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) await setSetting("ramp_started_on", d); else await q("DELETE FROM settings WHERE key='ramp_started_on'");
  redirect(res, "/admin/settings", "Saved");
});
