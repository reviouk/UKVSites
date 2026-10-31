#!/usr/bin/env node
/**
 * Creates (or refreshes) the two cold-email campaigns — one per brand — with the
 * 3-step sequence (tariff opener, recent events, tax quirk) at +0, +10, +13 days.
 * Copy is brand-specific: Market Watcher = market-intelligence voice ("the signal",
 * "Download the Whisky Guide"); The Invest Chronicle = editorial voice ("briefing").
 * Campaigns are created PAUSED; edit on /admin/campaigns/:id, enrol, then activate.
 *
 *   node scripts/seed-campaigns.mjs            # create if missing, leave existing copy alone
 *   node scripts/seed-campaigns.mjs --reset    # overwrite the steps with this file's copy
 *
 * Facts checked 31 Oct 2026:
 *  - US tariff on Scotch removed effective 24 Jul 2026 (announced 30 Apr); exports had fallen ~15%
 *  - UK–India CETA in force 15 Jul 2026: Scotch duty 150% -> 75%, to 40% over 10 years
 *  - H1 2026 Scotch exports +6% volume / +3% value; single malt volume +13.6%
 *  - UK CPI heading to ~3.75% Q4 2026 and >4% Q1 2027 (BoE); Bank Rate 3.75%, rise possible
 *  - Gold: worst October since 2008, below $3,900; Nasdaq 100 lost >$1.2tn in Oct 2026; US midterms 3 Nov
 *  - WOWGR owner registration abolished 3 Mar 2025; wasting-asset CGT treatment unchanged
 */
import "./_env.mjs";
const { q, one, pool } = await import("../src/db.js");
const RESET = process.argv.includes("--reset");

const BRANDS = {
  marketwatcher: {
    name: "Market Watcher – Cold sequence Nov 2026",
    brand: "Market Watcher",
    guide: "Download the Whisky Guide",
    guideNoun: "the Whisky Guide",
  },
  investchronicles: {
    name: "Invest Chronicles – Cold sequence Nov 2026",
    brand: "The Invest Chronicle",
    guide: "Request the cask ownership briefing",
    guideNoun: "the briefing",
  },
};

function steps(site) {
  const B = BRANDS[site];
  const CTA = `[${B.guide}]({{site_url}})`;
  const mw = site === "marketwatcher";
  return [
    // 1. Trump / US tariff (Rob's email, dates current, return claims softened)
    {
      delay_days: 0,
      subject: mw ? "Scotch tariff lifted: the cask angle" : "The US just reopened to Scotch whisky",
      preheader: mw
        ? "The US market reopened in July. Where that leaves casks maturing in bond now."
        : "A short briefing on what the tariff decision means for cask owners.",
      body: `Hi {{first_name|there}},

On 24 July President Trump removed the US tariff on Scotch whisky, restoring tariff-free access to the sector's single largest export market. For cask owners, that is a clear opening — and the timing is worth understanding.

${CTA}

The logic is straightforward. The US has long been the most valuable destination for Scotch, and the 10% tariff had been holding demand back — shipments fell around 15% while it was in place. With it gone, American buyers are expected to return, and rising demand for bottled Scotch flows straight back to the casks maturing today, because the spirit has to be laid down years in advance.

${mw
  ? "I help private investors select and manage Scotch whisky casks from established distilleries: full legal title in your name, secure HMRC-bonded storage, and a defined exit when the time is right. No screen to watch, no daily volatility — a real, tangible asset quietly maturing in a bonded warehouse in Scotland."
  : "I help private investors select and manage Scotch whisky casks from established distilleries: full legal ownership, secure HMRC-bonded storage, and a clear exit route when the time is right. No spreadsheets to watch, no daily volatility — just a real, tangible asset quietly maturing in a warehouse in Scotland."}

To see how ownership works and what is currently available:

${CTA}

Best,
{{sender_name}}
${B.brand}
{{site_url}}`,
    },
    // 2. Recent events
    {
      delay_days: 10,
      subject: mw ? "Off the screen while markets wobble" : "A quieter place for part of your money",
      preheader: mw
        ? "Inflation near 4%, gold's worst October since 2008 — and an asset with no ticker."
        : "Inflation, rate rises, gold's worst October since 2008 — and a cask that just gets older.",
      body: `Hi {{first_name|there}},

${mw ? "Quick market update." : "It has been an uncomfortable autumn for anyone watching a screen."} UK inflation is heading back towards 4% on the Bank of England's own forecast, Bank Rate sits at 3.75% with a rise on the table, gold has just had its worst October since 2008, and the Nasdaq lost more than a trillion dollars of value in a single month — with the US midterms days away and energy prices still hostage to the Middle East.

${CTA}

Against that, Scotch has quietly had a very good few months. The US tariff came off on 24 July, the UK–India trade deal came into force on 15 July and halved India's duty on Scotch from 150% to 75%, and exports returned to growth in the first half of 2026 — up around 6% by volume, with single malt up more than 13%.

A whisky cask is a different kind of asset from the ones making the headlines. It is a physical thing: a numbered cask of spirit from an established Scottish distillery, held in your name in an HMRC-bonded warehouse, insured, with duty and VAT suspended while it matures. There is no ticker and no daily price. It simply gets older, which is the whole point.

That is not a promise about what it will be worth — the value of a cask can fall as well as rise. But if you want part of your money in something tangible and slow, it is worth understanding how it works. ${mw ? "The guide" : "The briefing"} covers ownership, storage, costs and exit:

${CTA}

Best,
{{sender_name}}
${B.brand}
{{site_url}}`,
    },
    // 3. Email 3 — the tax quirk
    {
      delay_days: 13,
      subject: mw ? "The HMRC quirk on whisky casks" : "The tax quirk that makes casks interesting",
      preheader: mw
        ? "Why a maturing cask is a 'wasting asset' — and what that can mean at sale."
        : "The angel's share, HMRC's wasting-asset rule, and why it matters when you sell.",
      body: `Hi {{first_name|there}},

Here's something many first-time cask owners find pleasantly surprising.

${CTA}

Because a small amount of whisky naturally evaporates from the cask each year — distillers poetically call it "the angel's share" — HMRC generally treats a maturing cask as a "wasting asset". In practice, that often means any gain when you come to sell can fall outside Capital Gains Tax.

For an asset that matures and develops in character over the years, that is an unusual combination — and it is one of the reasons casks have caught the eye of people looking to diversify beyond the usual options.

One sensible note: tax treatment always depends on your own circumstances and can change over time, so it is worth having a quick word with an independent tax adviser about your specific position. I'm always happy to talk through the general principles.

If you'd like to, reply with a time that suits you and I'll call for 15 minutes — no script and no pressure. Or start with ${B.guideNoun}:

${CTA}

Best,
{{sender_name}}
${B.brand}
{{site_url}}`,
    },
  ];
}

await q("ALTER TABLE steps ADD COLUMN IF NOT EXISTS preheader TEXT NOT NULL DEFAULT ''");
for (const [site, B] of Object.entries(BRANDS)) {
  let row = await one("SELECT * FROM campaigns WHERE name=$1", [B.name]);
  if (!row) {
    row = await one("INSERT INTO campaigns(name,site,status) VALUES($1,$2,'paused') RETURNING *", [B.name, site]);
    console.log(`created campaign #${row.id} ${B.name}`);
  } else if (!RESET) { console.log(`exists  campaign #${row.id} ${B.name} (use --reset to overwrite steps)`); continue; }
  await q("DELETE FROM steps WHERE campaign_id=$1", [row.id]);
  const S = steps(site);
  for (let i = 0; i < S.length; i++) {
    await q("INSERT INTO steps(campaign_id,position,delay_days,subject,preheader,body_html) VALUES($1,$2,$3,$4,$5,$6)",
      [row.id, i + 1, S[i].delay_days, S[i].subject, S[i].preheader, S[i].body]);
  }
  console.log(`  ${S.length} steps written for #${row.id} (${site})`);
}
await pool.end();
