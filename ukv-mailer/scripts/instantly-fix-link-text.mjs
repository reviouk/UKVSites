#!/usr/bin/env node
/**
 * Instantly rewrites hrefs to its tracking host; a link whose visible text is a URL then mismatches its
 * target (phishing signal). Make every link's visible text words instead.  dry run by default; `apply` to write.
 */
import "./_env.mjs";
const APPLY = process.argv[2] === "apply";
const KEY = process.env.INSTANTLY_REPORT_API_KEY, API = "https://api.instantly.ai/api/v2";
const IDS = ["a6753784-0f6b-4ca6-becc-b65649d2f86a", "2cecb091-fd83-4b06-a647-a9fa1ee64637"];
const api = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: { Authorization: `Bearer ${KEY}`, ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${t.slice(0, 200)}`); return JSON.parse(t); };
const A = (attrs, text) => `<a ${attrs}>${text}</a>`;
function fix(body) {
  return body
    .replace(/Read the story: <a ([^>]*)>https?:[^<]*<\/a>/g, (_, a) => A(a, "Read the story"))
    .replace(/Reuters: <a ([^>]*)>https?:[^<]*<\/a>/g, (_, a) => A(a, "Reuters: Trump lifts tariffs on Scotch whisky"))
    .replace(/Watch the 47-second video: <a ([^>]*)>https?:[^<]*<\/a>/g, (_, a) => A(a, "Watch the 47-second video"))
    .replace(/<strong>Download the Whisky Guide → <a ([^>]*)>https?:[^<]*<\/a><\/strong>/g, (_, a) => `<strong>${A(a, "Download the Whisky Guide")}</strong>`);
}
for (const id of IDS) {
  const c = await api("GET", `/campaigns/${id}`);
  const seq = c.sequences.map(s => ({ steps: s.steps.map(st => ({ type: st.type, delay: st.delay, variants: st.variants.map(v => ({ subject: v.subject, body: fix(v.body) })) })) }));
  const left = seq[0].steps.flatMap(st => st.variants).map(v => (v.body.match(/<a [^>]*>https?:/g) || []).length);
  const links = seq[0].steps.flatMap(st => st.variants).map(v => [...v.body.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(m => `${m[2]} -> ${m[1].slice(0, 45)}`));
  console.log(c.name, "| URL-text links left per variant:", left); console.log(links);
  if (left.some(n => n)) throw new Error("some URL-text links not converted");
  if (APPLY) { await api("PATCH", `/campaigns/${id}`, { sequences: seq }); console.log("  updated"); }
}
if (!APPLY) console.log("dry run - nothing changed");
