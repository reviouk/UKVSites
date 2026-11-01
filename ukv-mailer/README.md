# ukv-mailer

Self-hosted replacement for Instantly. Sends the UKV International whisky-cask
cold-email campaigns from the 29 Maildoso mailboxes over SMTP, paces them to a
daily total, tracks opens / clicks / replies / bounces / unsubscribes, and pushes
engagement into HubSpot with the same contact properties the old Instantly
connector used (so active list 1851 and the lead-source reporting keep working).

```
spreadsheets ─► contacts ─► enrol in campaign ─► paced sender ─► Maildoso SMTP ─► prospect
                                                     │                              │
                                      open pixel / click redirect / unsubscribe ◄───┘
                                                     │
                                       master inbox IMAP (replies + bounces)
                                                     │
                                                  HubSpot upsert
```

## Layout

| Path | What |
|---|---|
| `src/server.js` | Express app: tracking routes, admin UI, starts the scheduler + IMAP poller |
| `src/sender.js` | Once a minute: sends the shortfall vs. an even spread of `DAILY_TOTAL` across the send window, picks a mailbox under its cap, threads follow-ups |
| `src/templates.js` | Merge fields, link rewriting, unsubscribe footer, open pixel |
| `src/tracking.js` | `/o/:token.gif`, `/c/:token?u=`, `/u/:token` (GET page + RFC 8058 one-click POST) |
| `src/replies.js` | IMAP poll of the Maildoso master inbox; reply → stop sequence, bounce → suppress |
| `src/hubspot.js` | Queued upserts: `instantly_opened/clicked`, `instantly_campaign`, `external_lead_source`, `data_source`, `ukv_replied`, `ukv_unsubscribed` |
| `src/importer.js` | CSV/XLSX import with automatic column detection (header or headerless) |
| `src/admin.js` | Dashboard, campaigns & steps, enrolment, contacts upload, mailboxes, replies, settings |
| `scripts/import.mjs` | Bulk import a folder of spreadsheets |
| `scripts/seed-mailboxes.mjs` | Upsert the 29 mailboxes (`data/mailboxes.csv`, or a Maildoso export with passwords) |
| `scripts/sync-instantly.mjs` | Pull Instantly campaigns (as paused campaigns here) and leads (flag already-contacted, suppress replied/bounced/unsubscribed) |
| `scripts/test-smtp.mjs` | Verify SMTP login for every mailbox |
| `scripts/classify-mx.mjs` | Tag contacts with the mail provider behind their domain's MX (microsoft / google / yahoo / apple / gateway / other / none). Settings → Routing sends each provider from a mailbox *pool* or holds it. Microsoft is held by default: Maildoso's relay has no reverse DNS and Microsoft 365 junks it (SFV:SPM, PTR:InfoDomainNonexistent) |
| `scripts/verify-emails.mjs` | Bulk email verification via MillionVerifier (`run` = upload, wait, import). Sets `contacts.verify_result`; invalid/disposable become `bounced`. Enrolment defaults to verified-OK only |

## Sending rules

* `DAILY_TOTAL` (default 1000) campaign emails per day, spread evenly over
  `SEND_WINDOW_START`–`SEND_WINDOW_END` (`TIMEZONE`, default 08:00–17:30
  Europe/London) on `SEND_DAYS` (Mon–Fri). Burst ceiling 12/minute.
* Per mailbox: `min(mailbox.daily_cap, MAILBOX_DAILY_CAP, warm-up limit)`, and the day's total is water-filled across
  mailboxes so low-cap (warm-up) boxes take only their limit and the others cover the rest.
* Warm-up: set `warmup_from` (Mailboxes page, or `seed-mailboxes.mjs --warmup`) and the box is limited to
  5/day in week 1, 10 in week 2, 20 in week 3, 30 in week 4, then only its normal cap.
* A brand whose mailboxes are all at their allowance for the day is skipped so the other brand keeps sending.
  With 29 mailboxes and 1000/day that is ~35–40 each.
* A campaign sends only from mailboxes of its `site`
  (`investchronicles` → openinvestchronicleshq.com, `marketwatcher` → the two
  Market Watcher domains). Follow-ups come from the same persona as step 1 and
  are threaded as replies.
* Sequences stop on reply, bounce, unsubscribe or manual suppression. Contacts
  on the suppression list are never sent to, in any campaign.
* An SMTP auth failure disables that mailbox automatically (re-enable on the
  Mailboxes page after fixing the password).

## Deploy (Render)

Web service `ukv-mailer` (Node, **starter** plan – the free tier sleeps and the
scheduler must stay awake) + Postgres `ukv-mailer-db` (basic-256mb). See
`render.yaml` and `.env.example` for every variable.

Required secrets: `DATABASE_URL`, `ADMIN_PASS`, `HUBSPOT_TOKEN`,
`IMAP_HOST` / `IMAP_USER` / `IMAP_PASS` (Maildoso master inbox).

## First-time setup

```bash
cp .env.example .env            # fill DATABASE_URL (Render external URL) etc.
npm install
npm run migrate
npm run seed-mailboxes          # 29 mailboxes, no passwords yet
node scripts/seed-mailboxes.mjs maildoso-export.csv   # or set passwords on /admin/mailboxes
npm run test-smtp
node scripts/sync-instantly.mjs # handover from Instantly
node scripts/import.mjs "C:\path\to\spreadsheets" --site marketwatcher
```

Then in `/admin`: create a campaign (or activate one imported from Instantly),
send yourself a test, enrol contacts by data source, activate.

## Compliance

Whisky cask investment is unregulated. Copy must not promise returns. Every
email carries the risk footer, a working unsubscribe link and the
`List-Unsubscribe` headers. Lawful basis for emailing purchased lists under UK
GDPR / PECR is the client's responsibility.
