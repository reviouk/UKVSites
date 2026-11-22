import express from "express";
import { cfg } from "./config.js";
import { migrate, getSetting } from "./db.js";
import { tracking } from "./tracking.js";
import { admin } from "./admin.js";
import { startSender, state as senderState } from "./sender.js";
import { startReplyPoller, replyState } from "./replies.js";
import { ensureProperties, startCompletionSync, nurtureState } from "./hubspot.js";
import { startInstantlyReplySync, instantlyReplyState } from "./instantly-replies.js";
import { startConversionSync } from "./conversions.js";
import { startCallbacks, cbState } from "./callbacks.js";
import { reportRoutes, startReportEmails, reportState } from "./report.js";
import { startBounceWatch, bounceWatchState } from "./bounce-watch.js";
import { startAutopilot, autopilotState } from "./autopilot.js";
import { startHealthWatch, healthWatchState } from "./health-watch.js";

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.redirect("/admin"));
app.get("/healthz", (_req, res) => res.json({
  ok: true, sentToday: senderState.sentToday, lastTick: senderState.lastTick, sender: senderState.lastResult,
  imap: replyState.configured ? replyState.lastResult : "disabled",
  callbacks: { enabled: cbState.enabled, lastTick: cbState.lastTick, result: cbState.lastResult },
  reportEmail: reportState.lastResult,
  nurtureCompleted: { lists: nurtureState.lists, result: nurtureState.lastResult },
  instantlyReplies: instantlyReplyState.lastResult,
  bounceWatch: bounceWatchState.lastResult,
  autopilot: autopilotState.lastResult,
  health: healthWatchState.lastResult,
}));

app.use(tracking);
app.use(reportRoutes);
app.use("/admin", admin);

// Setting send_days (e.g. "0,1,2,3,4,5,6", 0 = Sunday) overrides the SEND_DAYS env var, so sending days can change
// without a Render env edit. Rob, 22 Nov 2026: send on Saturday and Sunday as well.
async function applySettingOverrides() {
  const d = String(await getSetting("send_days", "") || "").trim();
  if (/^[0-6](,[0-6])*$/.test(d)) cfg.sendDays = d.split(",").map(Number);
}

app.listen(cfg.port, async () => {
  console.log(`ukv-mailer listening on :${cfg.port} (${cfg.baseUrl})`);
  await migrate();
  console.log("[db] schema ready");
  await applySettingOverrides().catch(e => console.warn("[settings] override failed:", e.message));
  setInterval(() => applySettingOverrides().catch(() => {}), 5 * 60_000);
  try { await ensureProperties(); } catch (e) { console.warn("[hubspot] property check failed:", e.message); }
  startSender();
  startReplyPoller();
  startConversionSync();
  startCallbacks();
  startReportEmails();
  startInstantlyReplySync();
  startCompletionSync();
  startBounceWatch();
  startAutopilot();
  startHealthWatch();
});
