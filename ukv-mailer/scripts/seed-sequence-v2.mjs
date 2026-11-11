#!/usr/bin/env node
/**
 * Nov 2026 v2 sequence ("why now" angles: cask prices below the boom, distilleries making less,
 * noisy markets + wasting-asset tax point). Light design: email 1 plain; emails 2-3 get one
 * text-style button and one video link (no images, to stay friendly with spam filters).
 *
 *   node scripts/seed-sequence-v2.mjs preview [--video=URL]   # (re)create PAUSED "PREVIEW v2" campaigns, one per brand
 *   node scripts/seed-sequence-v2.mjs apply     # overwrite the steps of the two live cold campaigns
 *
 * VIDEO_URL: set the video address below once chosen; "none" leaves the video line out.
 * Sources are listed in ../../nurture-drafts-2026-11-06.md.
 */
import "./_env.mjs";
const { q, one, all, pool } = await import("../src/db.js");
const MODE = process.argv[2];
const videoArg = (process.argv.find(a => a.startsWith("--video=")) || "").slice(8);
export const VIDEO_URL = { investchronicles: videoArg || "none", marketwatcher: videoArg || "none" };

const BRAND = {
  investchronicles: { name: "The Invest Chronicle", cta: "Request the cask ownership briefing", noun: "the briefing" },
  marketwatcher:    { name: "Market Watcher",       cta: "Download the Whisky Guide",           noun: "the guide" },
};
const sign = (b) => `Best,\n{{sender_name}}\n${b.name}\n{{site_url}}`;

export function steps(site) {
  const b = BRAND[site], video = VIDEO_URL[site] || "none";
  return [
    { delay_days: 0, subject: "Cask prices are back below the boom",
      preheader: "One valuation firm puts them about 28% under 2020-23 levels, just as two big export markets reopen.",
      body: `Hi {{first_name|there}},

At the end of October, the cask valuation firm CaskID published its latest estimate: comparable Scotch whisky casks are now trading about 28% below their 2020-23 levels, based on 767 recent sales and auctions.

That matters because the demand picture has moved the other way this year. The US, Scotch's biggest export market, dropped its tariff on 24 July. India's new trade deal with the UK halved the duty on Scotch from 150% to 75% in July, and it falls to 40% over the next ten years.

Lower prices, and two large markets opening up. That combination doesn't come round often.

If you've ever wondered how owning a cask works (what you own, where it's stored, the costs and how people sell), there's a short ${b.noun.replace("the ", "")} that covers it:

[${b.cta}]({{site_url}})

Is it something you've looked at before, or new to you?

${sign(b)}` },
    { delay_days: 3, subject: "Distilleries are making less whisky",
      preheader: "Bowmore, Laphroaig and others have cut back. Here's why that matters in ten years' time.",
      body: `Hi {{first_name|there}},

Over the past year, a number of Scottish distilleries have slowed down or stopped production. Suntory cut output at Bowmore and Laphroaig on Islay in February. Diageo paused its Teaninich distillery. More pauses were reported across Scotland in September.

Here's why that's interesting if you're thinking about a cask. Every bottle of 12, 15 or 18-year-old Scotch sold in the 2030s has to be distilled and put into a cask now. Whatever isn't laid down this year can't be made up later.

So the spirit already maturing in bond, filled before the cutbacks, is a finite supply. A cask you own today is part of that supply: a numbered cask from an established distillery, held in your name in an HMRC-bonded warehouse, insured, and getting older every year.

[[video: Watch: how a cask matures in a bonded warehouse]](${video})

None of this guarantees what a cask will be worth, and values can fall as well as rise. But it's the reason many people buy when the industry is quiet rather than when it's booming.

[${b.cta}]({{site_url}})

${sign(b)}` },
    { delay_days: 4, subject: "A quieter home for part of your money",
      preheader: "Rates up, tech down, gold up 5%. And a tax rule worth knowing about.",
      body: `Hi {{first_name|there}},

It's been a loud few days in the markets. On 5 November the Bank of England raised rates to 4%. The same day the Nasdaq 100 fell more than 6%, its worst session in a long time, and gold climbed about 5% in two days as investors looked for something solid.

A whisky cask sits outside all of that. It has no ticker and no daily price. It's a physical asset in a bonded warehouse in Scotland, with duty and VAT suspended while it matures.

There's also a tax point many people don't know. Because a little spirit evaporates from every cask each year, HMRC treats a maturing cask as a "wasting asset". That usually means any gain when you sell isn't subject to Capital Gains Tax. Your own position depends on your circumstances, so it's worth a quick word with a tax adviser.

[[video: Watch: what owning a cask actually involves]](${video})

This is my last note for now. If you'd like a 15-minute call, reply with a time that suits you. Or start with ${b.noun}:

[${b.cta}]({{site_url}})

${sign(b)}` },
  ];
}

async function writeSteps(campaignId, site) {
  await q("DELETE FROM steps WHERE campaign_id=$1", [campaignId]);
  for (const [i, s] of steps(site).entries())
    await q("INSERT INTO steps(campaign_id,position,delay_days,subject,preheader,body_html,reply_in_thread) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [campaignId, i + 1, s.delay_days, s.subject, s.preheader, s.body, true]);
}

if (MODE === "preview") {
  for (const site of Object.keys(BRAND)) {
    const name = `PREVIEW v2 (${BRAND[site].name}) - do not activate`;
    const c = (await one("SELECT * FROM campaigns WHERE name=$1", [name])) || await one("INSERT INTO campaigns(name,site,status) VALUES($1,$2,'paused') RETURNING *", [name, site]);
    await writeSteps(c.id, site);
    console.log(`preview campaign #${c.id} ${name}`);
  }
} else if (MODE === "apply") {
  for (const c of await all("SELECT * FROM campaigns WHERE name LIKE '%Cold sequence Nov 2026'")) { await writeSteps(c.id, c.site); console.log(`applied to #${c.id} ${c.name}`); }
} else if (MODE) { console.log("usage: preview | apply"); }
if (MODE) await pool.end();
