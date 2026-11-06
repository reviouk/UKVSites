import express from "express";
import { cfg } from "./config.js";
import { migrate } from "./db.js";
import { tracking } from "./tracking.js";
import { admin } from "./admin.js";
import { startSender, state as senderState } from "./sender.js";
import { startReplyPoller, replyState } from "./replies.js";
import { ensureProperties, startCompletionSync, nurtureState } from "./hubspot.js";
import { startConversionSync } from "./conversions.js";
import { startCallbacks, cbState } from "./callbacks.js";
import { reportRoutes, startReportEmails, reportState } from "./report.js";

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
}));

app.use(tracking);
app.use(reportRoutes);
app.use("/admin", admin);

app.listen(cfg.port, async () => {
  console.log(`ukv-mailer listening on :${cfg.port} (${cfg.baseUrl})`);
  await migrate();
  console.log("[db] schema ready");
  try { await ensureProperties(); } catch (e) { console.warn("[hubspot] property check failed:", e.message); }
  startSender();
  startReplyPoller();
  startConversionSync();
  startCallbacks();
  startReportEmails();
  startCompletionSync();
});
