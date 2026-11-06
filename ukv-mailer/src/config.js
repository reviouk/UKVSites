const env = (k, d) => (process.env[k] ?? d);
const bool = (k, d) => String(env(k, d)).toLowerCase() === "true";

export const cfg = {
  port: Number(env("PORT", 3000)),
  baseUrl: String(env("BASE_URL", "http://localhost:3000")).replace(/\/$/, ""),
  admin: { user: env("ADMIN_USER", "admin"), pass: env("ADMIN_PASS", "") },

  dailyTotal: Number(env("DAILY_TOTAL", 1000)),
  mailboxDailyCap: Number(env("MAILBOX_DAILY_CAP", 40)),
  sendDays: String(env("SEND_DAYS", "1,2,3,4,5")).split(",").map(Number),
  windowStart: env("SEND_WINDOW_START", "08:00"),
  windowEnd: env("SEND_WINDOW_END", "17:30"),
  tz: env("TIMEZONE", "Europe/London"),
  sendingEnabled: bool("SENDING_ENABLED", "true"),

  smtp: { host: env("SMTP_HOST", "smtp.maildoso.com"), port: Number(env("SMTP_PORT", 587)) },
  imap: {
    host: env("IMAP_HOST", ""),
    port: Number(env("IMAP_PORT", 993)),
    user: env("IMAP_USER", ""),
    pass: env("IMAP_PASS", ""),
    pollMinutes: Number(env("IMAP_POLL_MINUTES", 5)),
  },
  hubspot: { token: env("HUBSPOT_TOKEN", ""), enabled: bool("HUBSPOT_ENABLED", "true") },
};

// Site key -> landing page + HubSpot lead-source dropdown value. The leadSource
// strings must match the option values in external_lead_source exactly (copied
// from the Instantly connector's SITE_MAP).
export const SITES = {
  investchronicles: { label: "The Invest Chronicle", url: "https://investchronicles.com", leadSource: "investchronicles", color: "#7a2230" },
  marketwatcher:    { label: "Market Watcher",    url: "https://marketwatcher.co.uk",  leadSource: "Marketwatcher", color: "#1b8e67" },
};
// Tracking links (click redirect, open pixel, unsubscribe) are served from a brand
// subdomain (TRACK_URL_INVESTCHRONICLES / TRACK_URL_MARKETWATCHER, e.g.
// https://go.investchronicles.com -> CNAME to the Render service) rather than the
// shared *.onrender.com host, which inbox filters score as throwaway hosting.
for (const [key, s] of Object.entries(SITES)) {
  s.trackUrl = String(env(`TRACK_URL_${key.toUpperCase()}`, cfg.baseUrl)).replace(/\/$/, "");
}
// Step 1 goes out with no open pixel so the first touch reads as a plain 1:1 email.
// Its links are click-tracked through the brand subdomain (so clicks reach HubSpot)
// unless TRACK_STEP1_CLICKS=false. TRACK_STEP1=true adds the open pixel as well.
cfg.trackStep1 = bool("TRACK_STEP1", false);
cfg.trackStep1Clicks = cfg.trackStep1 || bool("TRACK_STEP1_CLICKS", true);

/** Wall-clock in the configured timezone: { day 0-6, minutes since midnight, dateKey YYYY-MM-DD } */
export function nowLocal(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: cfg.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: days[parts.weekday],
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const windowMinutes = () => Math.max(1, toMin(cfg.windowEnd) - toMin(cfg.windowStart));
export function inSendWindow(d = new Date()) {
  const { day, minutes } = nowLocal(d);
  return cfg.sendDays.includes(day) && minutes >= toMin(cfg.windowStart) && minutes < toMin(cfg.windowEnd);
}
/** Minutes elapsed in today's window so far (0 before it opens, full length after it closes). */
export function windowElapsed(d = new Date()) {
  const { minutes } = nowLocal(d);
  return Math.min(windowMinutes(), Math.max(0, minutes - toMin(cfg.windowStart)));
}
/** Start of "today" (local send-day) as a UTC Date, for per-day counts. */
export function startOfLocalDay(d = new Date()) {
  const { dateKey } = nowLocal(d);
  // Find the UTC instant at which the local date flips to dateKey (handles BST/GMT).
  const guess = new Date(`${dateKey}T00:00:00Z`);
  for (const offsetH of [0, -1, 1]) {
    const t = new Date(guess.getTime() + offsetH * 3600e3);
    if (nowLocal(t).dateKey === dateKey && nowLocal(new Date(t.getTime() - 60e3)).dateKey !== dateKey) return t;
  }
  return guess;
}
