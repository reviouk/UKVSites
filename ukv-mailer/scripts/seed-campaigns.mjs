#!/usr/bin/env node
/**
 * Creates (or refreshes) the two cold-email campaigns — one per sending brand —
 * with the 3-step sequence (tariff opener, recent events, tax quirk). Campaigns
 * are created PAUSED; edit copy on /admin/campaigns/:id, enrol, then activate.
 *
 *   node scripts/seed-campaigns.mjs            # create if missing, leave existing copy alone
 *   node scripts/seed-campaigns.mjs --reset    # overwrite the steps with this file's copy
 */
import "./_env.mjs";
const { q, one, pool } = await import("../src/db.js");
const RESET = process.argv.includes("--reset");

// Facts checked 31 Oct 2026:
//  - US tariff on Scotch removed effective 24 Jul 2026 (announced 30 Apr)
//  - UK–India CETA in force 15 Jul 2026: Scotch duty 150% -> 75%, to 40% over 10 years
//  - H1 2026 Scotch exports +6% volume / +3% value (Decant Index / SWA data)
//  - UK CPI heading to ~3.75% Q4 2026 and >4% Q1 2027 (BoE); Bank Rate 3.75%, may rise
//  - Gold: worst October since 2008, below $3,900; Nasdaq 100 lost >$1.2tn in Oct 2026
//  - WOWGR owner registration abolished 3 Mar 2025
//  - Wasting-asset CGT treatment of maturing casks (HMRC) unchanged
const STEPS = [
  // 1. The Trump / US tariff email (Rob's copy, dates made current, return claims softened)
  {
    delay_days: 0,
    subject: "US tariff on Scotch whisky removed — what it means for casks",
    body: `Hi {{first_name|there}},

On 24 July President Trump removed the US tariff on Scotch whisky, restoring tariff-free access to the sector's single largest export market. For cask owners, that is a clear opening — and the timing is worth understanding.

[Download the free Whisky Cask Guide]({{site_url}})

The logic is straightforward. The US has long been the most valuable destination for Scotch, and the 10% tariff had been holding demand back — shipments fell around 15% while it was in place. With it gone, American buyers are expected to return, and rising demand for bottled Scotch flows straight back to the casks maturing today, because the spirit has to be laid down years in advance.

I help investors select and manage Scotch whisky casks from established distilleries: full legal ownership, secure HMRC-bonded storage, and a clear exit route when the time is right. No spreadsheets to watch, no daily volatility — just a real, tangible asset quietly maturing in a warehouse in Scotland.

To see how ownership works and what is currently available:

[Download the free Whisky Cask Guide]({{site_url}})

Best,
{{sender_name}}
{{site_name}}`,
  },
  // 2. New: recent events (facts checked 31 Oct 2026, see header comment)
  {
    delay_days: 10,
    subject: "A real asset while the markets are jumpy",
    body: `Hi {{first_name|there}},

It has been an uncomfortable autumn for anyone watching a screen. UK inflation is heading back towards 4% on the Bank of England's own forecast, Bank Rate sits at 3.75% with a rise on the table, gold has just had its worst October since 2008, and the Nasdaq lost more than a trillion dollars of value in a single month, with the US midterms days away and energy prices still hostage to the Middle East.

[Download the free Whisky Cask Guide]({{site_url}})

Against that, Scotch has quietly had a very good few months. The US tariff came off on 24 July, the UK–India trade deal came into force on 15 July and halved India's duty on Scotch from 150% to 75%, and exports returned to growth in the first half of 2026 — up around 6% by volume, with single malt up more than 13%.

A whisky cask is a different kind of asset from the ones making the headlines. It is a physical thing: a numbered cask of spirit from an established Scottish distillery, held in your name in an HMRC-bonded warehouse, insured, with duty and VAT suspended while it matures. There is no ticker and no daily price. It simply gets older, which is the whole point.

That is not a promise about what it will be worth — the value of a cask can fall as well as rise. But if you want part of your money in something tangible and slow, it is worth understanding how it works. The guide covers ownership, storage, costs and exit:

[Download the free Whisky Cask Guide]({{site_url}})

Best,
{{sender_name}}
{{site_name}}`,
  },
  // 3. Email 3 — the tax quirk
  {
    delay_days: 13,
    subject: "The tax quirk that makes whisky casks interesting",
    body: `Hi {{first_name|there}},

Here's something many first-time cask owners find pleasantly surprising.

[Download the free Whisky Cask Guide]({{site_url}})

Because a small amount of whisky naturally evaporates from the cask each year — distillers poetically call it "the angel's share" — HMRC generally treats a maturing cask as a "wasting asset". In practice, that often means any gain when you come to sell can fall outside Capital Gains Tax.

For an asset that matures and develops in character over the years, that is an unusual combination — and it is one of the reasons casks have caught the eye of people looking to diversify beyond the usual options.

One sensible note: tax treatment always depends on your own circumstances and can change over time, so it is worth having a quick word with an independent tax adviser about your specific position. I'm always happy to talk through the general principles.

If you'd like to, reply with a time that suits you and I'll call for 15 minutes — no script and no pressure. Or start with the guide:

[Download the free Whisky Cask Guide]({{site_url}})

Best,
{{sender_name}}
{{site_name}}`,
  },
];

const CAMPAIGNS = [
  { name: "Market Watcher – Cold sequence Nov 2026", site: "marketwatcher" },
  { name: "Invest Chronicles – Cold sequence Nov 2026", site: "investchronicles" },
];

for (const c of CAMPAIGNS) {
  let row = await one("SELECT * FROM campaigns WHERE name=$1", [c.name]);
  if (!row) {
    row = await one("INSERT INTO campaigns(name,site,status) VALUES($1,$2,'paused') RETURNING *", [c.name, c.site]);
    console.log(`created campaign #${row.id} ${c.name}`);
  } else if (!RESET) { console.log(`exists  campaign #${row.id} ${c.name} (use --reset to overwrite steps)`); continue; }
  await q("DELETE FROM steps WHERE campaign_id=$1", [row.id]);
  for (let i = 0; i < STEPS.length; i++) {
    await q("INSERT INTO steps(campaign_id,position,delay_days,subject,body_html) VALUES($1,$2,$3,$4,$5)",
      [row.id, i + 1, STEPS[i].delay_days, STEPS[i].subject, STEPS[i].body]);
  }
  console.log(`  ${STEPS.length} steps written for #${row.id}`);
}
await pool.end();
