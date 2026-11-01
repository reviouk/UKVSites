# Google Workspace sending pool

Why: Microsoft 365 / Outlook junk every message that leaves Maildoso's shared relay
(`X-Forefront-Antispam-Report: SFV:SPM … PTR:InfoDomainNonexistent`, HELO is the
`in-addr.arpa` name). Gmail and the independent gateways accept it. So Microsoft-hosted
contacts are **held** by the routing table until a pool of real Google Workspace mailboxes
exists. Google's sending IPs are the ones Microsoft trusts most, and the accounts are ours.

The app side is done: mailboxes have a `pool`, an `auth_type`, and Google mailboxes
authenticate with one service-account key (no per-user app passwords, no 2-step
verification). What follows is the part that has to be done in Google and at the registrar.

## 1. Domains

- Buy **new** domains for sending; never send cold email from `investchronicles.com` or
  `marketwatcher.co.uk` themselves. Pattern that works: brand word + a plain suffix, `.com`
  or `.co.uk`, e.g. `investchroniclesmail.com`, `theinvestchronicle.co.uk`,
  `marketwatcherdesk.com`. Avoid hyphens, numbers and anything spammy-looking.
- 2–3 mailboxes per domain, 20–30 sends per mailbox per day once warmed. For ~400/day
  to Microsoft + Gmail targets that is **~16 mailboxes on 6–8 domains**; scale later.
- Each domain's root should 301-redirect to the brand site (`https://investchronicles.com`
  or `https://marketwatcher.co.uk`) so a curious recipient lands somewhere real.
- Add a CNAME `go` → `ukv-mailer.onrender.com` is **not** needed on these domains: tracking
  links already use `go.investchronicles.com` / `go.marketwatcher.co.uk`.

## 2. Google Workspace

1. In the existing Workspace admin console (or a new tenant on the first sending domain),
   **Account → Domains → Manage domains → Add a domain** for every sending domain. Verify
   each one with the TXT record Google gives you.
2. Set Google's MX records on each domain (Google shows them during verification).
3. **Users**: create the persona users, e.g. `j.whitfield@investchroniclesmail.com`,
   with the persona's display name. Business Starter is enough. You can bulk-create
   from a CSV under Users → Bulk update users.
4. **Authentication DNS on every sending domain**:
   - SPF: `v=spf1 include:_spf.google.com ~all`
   - DKIM: Apps → Google Workspace → Gmail → Authenticate email → generate a 2048-bit key
     for the domain, add the TXT record, then click *Start authentication* (wait up to 48 h
     after adding the record before starting).
   - DMARC: `_dmarc` TXT `v=DMARC1; p=quarantine; rua=mailto:dmarc@<brand domain>; adkim=s; aspf=s`
     (start at `p=none` for the first week if you want to watch reports first).
5. **Replies and bounces into the master inbox**: Apps → Google Workspace → Gmail →
   Routing → *Routing* → Add rule: inbound messages, *Also deliver to* the master inbox
   `mike.leverington@maildoso.email` (add it as an "Add more recipients" entry). This
   keeps the original headers, so the existing reply poller matches replies to sends
   by Message-ID exactly as it does for Maildoso. Alternatively set per-user forwarding,
   but the routing rule covers every user at once.
6. **Sending limits**: Workspace allows 2,000/day per user; we stay at 20–30. Keep the
   per-mailbox warm-up schedule (5/10/20/30 per day by week) by seeding with `--warmup`.

## 3. Service account (one key for every mailbox)

1. Google Cloud console → create a project (e.g. `ukv-mailer`) → **APIs & Services →
   Enable APIs** → enable the **Gmail API**.
2. **IAM & Admin → Service accounts → Create**. Name it `ukv-mailer-sender`. No roles needed.
3. Open the service account → **Keys → Add key → JSON**. Download the JSON file. Note the
   **Client ID** (a long number, also inside the JSON as `client_id`).
4. Workspace admin console → **Security → Access and data control → API controls →
   Manage domain-wide delegation → Add new**: paste the Client ID, scope
   `https://mail.google.com/`. Authorise.
5. Put the JSON on Render as `GOOGLE_SA_JSON` (base64 of the file is easiest; raw JSON
   also works) and in the local `.env`. Never commit it.

   ```bash
   base64 -w0 ukv-mailer-sender.json
   ```

## 4. Load the mailboxes into the app

Make a CSV with `email,display_name,site` (site = `investchronicles` or `marketwatcher`), then:

```bash
node scripts/seed-mailboxes.mjs google-mailboxes.csv --google --warmup
```

That puts them in pool `google`, auth `google`, SMTP `smtp.gmail.com:465`, warm-up starting
today. On the Mailboxes page use **Test login** on one of them: it performs a real OAuth2
SMTP login with the service account and shows any delegation or scope error.

## 5. Switch routing

Settings → *Routing by recipient mail provider* → set **microsoft** to pool `google`.
Optionally also move **google** (Gmail-hosted recipients) to the `google` pool once it has
capacity; Gmail-to-Gmail places best. Held contacts start sending on the next tick.

## 6. Watch

- Mailboxes page: today's sends per mailbox and the warm-up allowance.
- Stats page: open/reply/bounce by mailbox and by domain. Pull a domain out (disable its
  mailboxes) if bounces or spam complaints climb.
- Keep the Maildoso pool for `other`, `gateway`, `yahoo`, `apple`, `none` recipients.
