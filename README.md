# UKV Sites — Whisky Cask Campaign Landing Pages

Two standalone landing pages for a cold-email whisky cask investment campaign.
Same offer, two distinct looks, one per domain.

| Folder              | Domain                  | Look                        |
|---------------------|-------------------------|-----------------------------|
| `investchronicles/` | `investchronicles.com`  | Editorial / newspaper       |
| `marketwatcher/`    | `marketwatcher.co.uk`   | Market-data / fintech dark  |

Plain HTML + CSS. **No build step.** Each folder is a self-contained static site.

---

## Deploy on Render (one Static Site per folder)

Create **two** Static Sites from this same repo:

| Setting          | Site 1                 | Site 2              |
|------------------|------------------------|---------------------|
| Root Directory   | `investchronicles`     | `marketwatcher`     |
| Build Command    | *(leave empty)*        | *(leave empty)*     |
| Publish Directory| `.`                    | `.`                 |

> Static Site = no start command, no Go build. This fixes the earlier
> `go build` error (Render only tried Go because the repo had no real code).

Then **Settings → Custom Domains** on each service and add the matching domain
(plus its `www`). Point DNS at Render as instructed in the dashboard.

---

## Before going live — two placeholders to replace

Search-and-replace these in **both** `index.html` files (and the `thanks.html`):

1. **`YOUR_FORM_ID`** — the `<form action>` posts to Formspree. Create a free
   form at https://formspree.io, then replace
   `https://formspree.io/f/YOUR_FORM_ID` with your real endpoint.
   (Or swap the action for your own CRM/webhook.) The form already includes a
   `_next` redirect to `thanks.html` and a `source` field tagging which domain
   the lead came from.

2. **`YOUR-LINK`** — the "Book a call" buttons link to
   `https://calendly.com/YOUR-LINK`. Replace with your real Calendly/booking URL.

---

## Compliance note

Whisky cask investment is **unregulated** (not FCA-covered, no FSCS). Both pages
carry a capital-at-risk warning and deliberately contain **no return figures or
performance claims**. Keep it that way — the ASA/FCA scrutinise exactly those in
this sector. Review copy with your own compliance sign-off before sending.
