#!/usr/bin/env node
/**
 * Mike's (UKV) replacement sequence, Nov 2026: Glenrothes 1969 cask, US tariff, Knight Frank index.
 * Plain text until the mailboxes are warm (agreed with Mike); emails 2-3 carry the video link.
 * Edits from Mike's draft: dated facts made accurate ("recently", tariff removed in July), brand
 * voice instead of "UKV International", past-performance + CGT caveats, brand CTA added.
 *
 *   node scripts/seed-sequence-mike.mjs apply     # overwrite steps of the two live cold campaigns (ids 1, 2)
 *   node scripts/seed-sequence-mike.mjs print     # show the copy for one brand
 */
import "./_env.mjs";
const { q, all, pool } = await import("../src/db.js");
const MODE = process.argv[2];

const BRAND = {
  investchronicles: { name: "The Invest Chronicle", cta: "Request the cask ownership briefing", video: "https://investchronicles.com/#video" },
  marketwatcher:    { name: "Market Watcher",       cta: "Download the Whisky Guide",           video: "https://marketwatcher.co.uk/#video" },
};
const sign = (b) => `Best,\n{{sender_name}}\n${b.name}\n{{site_url}}`;
const GLENROTHES = "https://www.thedrinksbusiness.com/2026/08/130-whisky-cask-bought-in-1971-now-valued-at-270000/";
const TARIFF = "https://www.reuters.com/world/us/trump-says-he-will-lift-tariffs-restrictions-on-scotland-kentucky-whiskey-ties-2026-04-30/";

export function steps(site) {
  const b = BRAND[site];
  return [
    { delay_days: 0, subject: "A 1969 Glenrothes cask valued at £270,000",
      preheader: "The oldest Glenrothes cask ever offered for public sale, and what it says about aged whisky.",
      body: `Hi {{first_name|there}},

I hope you're well. I think you'll like this story.

A single Glenrothes cask, filled in 1969, has recently been valued at £270,000.

[Read the story](${GLENROTHES})

At 57 years old, it is the oldest Glenrothes cask ever offered for public sale. It holds enough for around 287 bottles and is still at 42.2% ABV.

It highlights what matters with aged whisky: distillery, wood, provenance and storage. Every mature cask that is bottled permanently reduces the supply that is left, which makes well-aged stock increasingly scarce.

We currently have access to Glenrothes and selected Speyside casks, held in bonded storage with full documentation and provenance.

The £270,000 headline will attract attention. A small number of people will act on it.

[${b.cta}]({{site_url}})

Have a great rest of the week.

${sign(b)}` },
    { delay_days: 3, subject: "What the US tariff decision means for casks",
      preheader: "The US removed all tariffs on Scotch whisky. The knock-on effect is bigger than it sounds.",
      body: `Hi {{first_name|there}},

Since the US removed all tariffs on Scotch whisky in July, export conditions have materially improved.

We are expecting US buyers to keep returning to the market, which could tighten supply and support pricing, particularly on well-positioned casks and premium stock.

It's one of those changes that sounds simple but has quite a big knock-on effect.

[Reuters: Trump lifts tariffs on Scotch whisky](${TARIFF})

It's often the surprises no one sees coming that move the market the most.

[[video: Watch: whisky cask ownership in under a minute]](${b.video})

[${b.cta}]({{site_url}})

${sign(b)}` },
    { delay_days: 4, subject: "How rare whisky has performed over ten years",
      preheader: "Rare whisky was the strongest performer in Knight Frank's luxury index over the past decade.",
      body: `Hi {{first_name|there}},

One of the key reasons investors consider whisky is its historical performance as a luxury asset.

According to the Knight Frank Luxury Investment Index 2026, rare whisky delivered a 111.9% total return between 2016 and 31 December 2025. That made it the strongest-performing asset class in the index, ahead of fine wine, classic cars and the wider luxury index. Past performance is not a reliable guide to future returns, and the index tracks rare bottles rather than casks.

For our clients, this history is a useful starting point when considering whisky as part of a diversified portfolio. Combined with owning a tangible asset, private ownership of the cask and the opportunity to benefit from maturation over time, whisky can offer an alternative to more traditional investment markets.

The key benefits of whisky cask ownership:
• Tangible asset: you own the cask, held in your name in a bonded warehouse in Scotland.
• Long-term potential: whisky matures over time, with the potential to increase in value as it ages and demand develops.
• Diversification: exposure to a specialist asset class beyond traditional financial markets.
• Tax: usually free of Capital Gains Tax, as HMRC treats a maturing cask as a wasting asset. Your own position depends on your circumstances.

[[video: Watch: whisky cask ownership in under a minute]](${b.video})

Feel free to explore more:

[${b.cta}]({{site_url}})

${sign(b)}` },
  ];
}

async function writeSteps(campaignId, site) {
  await q("DELETE FROM steps WHERE campaign_id=$1", [campaignId]);
  for (const [i, s] of steps(site).entries())
    await q("INSERT INTO steps(campaign_id,position,delay_days,subject,preheader,body_html,reply_in_thread) VALUES($1,$2,$3,$4,$5,$6,true)",
      [campaignId, i + 1, s.delay_days, s.subject, s.preheader, s.body]);
}

if (MODE === "apply") {
  for (const c of await all("SELECT * FROM campaigns WHERE name LIKE '%Cold sequence Nov 2026'")) { await writeSteps(c.id, c.site); console.log(`applied to #${c.id} ${c.name}`); }
} else if (MODE === "print") {
  for (const s of steps("marketwatcher")) console.log(`\n=== ${s.subject}\n${s.body}`);
}
if (MODE) await pool.end();
