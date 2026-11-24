/**
 * Weekly opens & clicks spreadsheet for Mike (Rob, 24 Nov 2026): everyone in the HubSpot Opened / Clicked lists
 * (1892 Opened IC, 1893 Opened MW, 1900 Clicked IC, 1901 Clicked MW) with the details from the original lead
 * spreadsheets (name, email, phone, alt phone, address, postcode, title, company, data source, lead source).
 * Two tabs: "New this week" (joined a list in the last 7 days) and "All opens & clicks". Emailed as an .xlsx
 * attachment from the report mailbox to the daily-report recipients (report_email_to / _cc).
 *
 * Settings: report_weekly_enabled "true" | report_weekly_day 0-6 (default 2 = Tuesday) | report_weekly_time "08:00"
 *           report_weekly_last (date last sent) | report_weekly_send_once "true" = send now, then cleared.
 * Never names the sending tools (client-facing).
 */
import XLSX from "xlsx";
import { cfg, nowLocal } from "./config.js";
import { all, getSetting, setSetting } from "./db.js";
import { transportFor } from "./mailer.js";
import { dailyEmailSettings } from "./report-daily.js";

const LISTS = { 1892: ["opened", "The Invest Chronicle"], 1893: ["opened", "Market Watcher"], 1900: ["clicked", "The Invest Chronicle"], 1901: ["clicked", "Market Watcher"] };
const hs = async (path, body) => {
  const r = await fetch(`https://api.hubapi.com${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`HubSpot ${path} -> ${r.status}`);
  return r.json();
};
const ukDate = (t) => (t ? new Date(t).toLocaleDateString("en-GB", { timeZone: cfg.tz, day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const niceDay = (t) => new Date(t).toLocaleDateString("en-GB", { timeZone: cfg.tz, day: "numeric", month: "short", year: "numeric" });

/** Everyone in the opened/clicked lists, one row per person, newest clicks first. */
export async function opensClicksRows() {
  if (!process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN not set");
  const people = new Map();                         // HubSpot record id -> { brands:Set, opened, clicked }
  for (const [id, [kind, brand]] of Object.entries(LISTS)) {
    let after;
    do {
      const j = await hs(`/crm/v3/lists/${id}/memberships/join-order?limit=250${after ? "&after=" + after : ""}`);
      for (const m of j.results || []) {
        const p = people.get(m.recordId) || { brands: new Set(), opened: null, clicked: null };
        p.brands.add(brand);
        const t = Date.parse(m.membershipTimestamp) || null;
        if (t && (!p[kind] || t < p[kind])) p[kind] = t;
        people.set(m.recordId, p);
      }
      after = j.paging?.next?.after;
    } while (after);
  }
  const ids = [...people.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const j = await hs("/crm/v3/objects/contacts/batch/read", { properties: ["email", "firstname", "lastname", "phone", "mobilephone"], inputs: ids.slice(i, i + 100).map(id => ({ id })) });
    for (const x of j.results || []) Object.assign(people.get(x.id) || {}, { hs: x.properties });
  }
  const emails = [...people.values()].map(p => String(p.hs?.email || "").toLowerCase()).filter(Boolean);
  const db = new Map((await all(`SELECT lower(email) e, first_name, last_name, phone, postcode, job_title, company, data_source, extra, status, converted_at
    FROM contacts WHERE lower(email) = ANY($1)`, [emails])).map(r => [r.e, r]));
  const rows = [];
  for (const p of people.values()) {
    const email = String(p.hs?.email || "").toLowerCase();
    if (!email) continue;
    const c = db.get(email) || {}, x = c.extra || {};
    const status = [c.status === "replied" && "Replied", c.status === "unsubscribed" && "Unsubscribed", c.converted_at && "Filled in a website form"].filter(Boolean).join(", ");
    rows.push({
      _added: Math.min(...[p.opened, p.clicked].filter(Boolean)), _clicked: p.clicked || 0,
      "Brand": [...p.brands].sort().join(" + "),
      "Opened (date added)": ukDate(p.opened || p.clicked),
      "Clicked (date)": ukDate(p.clicked),
      "First name": c.first_name || p.hs?.firstname || "",
      "Last name": c.last_name || p.hs?.lastname || "",
      "Email": email,
      "Phone": c.phone || p.hs?.phone || p.hs?.mobilephone || "",
      "Alt phone": x.alt_phone || "",
      "Address": x.address || "",
      "Postcode": c.postcode || "",
      "Title / job title": c.job_title || "",
      "Company": c.company || "",
      "Data source": c.data_source || "",
      "Lead source": x.lead_source || "",
      "Status": status,
    });
  }
  rows.sort((a, b) => (b._clicked > 0) - (a._clicked > 0) || b._added - a._added);
  return rows;
}

// cols = the columns to show (any that are empty for everyone are left out).
function sheet(rows, cols) {
  const clean = rows.map(r => Object.fromEntries(cols.map(k => [k, r[k]])));
  const ws = clean.length ? XLSX.utils.json_to_sheet(clean, { header: cols }) : XLSX.utils.aoa_to_sheet([cols, ["Nobody new this week"]]);
  const widths = { "Brand": 30, "Opened (date added)": 13, "Clicked (date)": 13, "First name": 14, "Last name": 16, "Email": 34, "Phone": 16, "Alt phone": 14,
    "Address": 40, "Postcode": 10, "Title / job title": 18, "Company": 22, "Data source": 24, "Lead source": 14, "Status": 24 };
  ws["!cols"] = cols.map(k => ({ wch: widths[k] || 14 }));
  if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
  return ws;
}

/** Builds the workbook. Returns { buffer, filename, total, clicked, newThisWeek }. */
export async function buildOpensClicksWorkbook(now = Date.now()) {
  const rows = await opensClicksRows();
  const weekAgo = now - 7 * 86400e3;
  const fresh = rows.filter(r => r._added >= weekAgo || r._clicked >= weekAgo);
  const wb = XLSX.utils.book_new();
  const cols = Object.keys(rows[0] || { "Brand": "" }).filter(k => !k.startsWith("_") && (k === "Clicked (date)" || rows.some(r => r[k])));
  XLSX.utils.book_append_sheet(wb, sheet(fresh, cols), "New this week");
  XLSX.utils.book_append_sheet(wb, sheet(rows, cols), "All opens & clicks");
  return {
    buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }),
    filename: `UKV opens and clicks - ${niceDay(now)}.xlsx`,
    total: rows.length, clicked: rows.filter(r => r._clicked).length, newThisWeek: fresh.length,
  };
}

export async function sendWeeklySheet({ first = false, to, cc } = {}) {
  const s = await dailyEmailSettings();
  to = to || s.to; cc = cc || s.cc;
  if (!to.length) throw new Error("No recipients (report_email_to)");
  const mailbox = s.mailbox && (await all("SELECT * FROM mailboxes WHERE lower(email)=lower($1)", [s.mailbox]))[0];
  if (!mailbox) throw new Error("setting report_email_mailbox not set");
  const wb = await buildOpensClicksWorkbook();
  const n = (x) => x.toLocaleString("en-GB");
  const p = (t) => `<p style="font:15px/1.5 Helvetica,Arial,sans-serif;margin:0 0 12px">${t}</p>`;
  const html = `<div style="max-width:560px;color:#191714">${p("Hi Mike,")}${
    p(first ? `Attached is the spreadsheet of everyone who has opened or clicked our emails so far: <b>${n(wb.total)}</b> people, of whom <b>${n(wb.clicked)}</b> clicked through.`
            : `Attached is this week's spreadsheet of opens and clicks: <b>${n(wb.newThisWeek)}</b> new this week, <b>${n(wb.total)}</b> in total, of whom <b>${n(wb.clicked)}</b> clicked through.`)}${
    p(`It has two tabs: <b>New this week</b> (the last 7 days${first ? `, ${n(wb.newThisWeek)} people` : ""}) and <b>All opens &amp; clicks</b>. Each row has the details from the original lead spreadsheets: name, email, phone, address and postcode where we have them, and the data source. People who clicked are listed first.`)}${
    p(`The Status column shows anyone who has replied, unsubscribed or filled in a website form.`)}${
    first ? p("You'll receive an updated copy every Tuesday morning.") : ""}</div>`;
  const subject = `Opens and clicks spreadsheet – ${niceDay(Date.now())}`;
  await transportFor(mailbox).sendMail({ from: { name: "Campaign Report", address: mailbox.email }, to, cc: cc.length ? cc : undefined, subject, html,
    attachments: [{ filename: wb.filename, content: wb.buffer, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }] });
  return { subject, total: wb.total, newThisWeek: wb.newThisWeek };
}

/** Called from the report tick (every 10 min). Returns a status string. */
export async function weeklyTick() {
  if ((await getSetting("report_weekly_send_once", "")) === "true") {
    await setSetting("report_weekly_send_once", "");
    const r = await sendWeeklySheet({ first: (await getSetting("report_weekly_last", "")) === "" }).catch(e => { throw new Error(`one-off failed: ${e.message}`); });
    await setSetting("report_weekly_last", nowLocal().dateKey);
    return `weekly sheet: sent now (${r.total} people)`;
  }
  if ((await getSetting("report_weekly_enabled", "")) !== "true") return "weekly sheet: off";
  const day = Number(await getSetting("report_weekly_day", "2")), [hh, mm] = (await getSetting("report_weekly_time", "08:00")).split(":").map(Number);
  const { dateKey, minutes } = nowLocal(), last = await getSetting("report_weekly_last", "");
  const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  if (weekday !== day || minutes < hh * 60 + (mm || 0) || last === dateKey) return `weekly sheet: last ${last || "never"}`;
  if (minutes > 14 * 60) return `weekly sheet: error, not sent today (last ${last || "never"})`;  // health-watch alerts on this
  try {
    const r = await sendWeeklySheet();
    await setSetting("report_weekly_last", dateKey);
    return `weekly sheet: sent ${dateKey} (${r.newThisWeek} new, ${r.total} total)`;
  } catch (e) { return `weekly sheet: error ${e.message} (retrying every 10 min until 14:00)`; }
}
