#!/usr/bin/env node
/**
 * Bulk import spreadsheets into the contacts table.
 *
 *   node scripts/import.mjs <file-or-folder> [more files…] [--site marketwatcher] [--source "GM CLEAN"]
 *
 * Folders are scanned for *.csv / *.xlsx (an .xlsx is skipped when a .csv twin exists).
 * Columns are detected automatically; existing non-blank contact fields are never overwritten.
 */
import "./_env.mjs";
import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const site = opt("--site") || null;
const dataSource = opt("--source") || "";
if (!args.length) { console.error("usage: node scripts/import.mjs <file-or-folder>... [--site x] [--source label]"); process.exit(1); }

const files = [];
for (const a of args) {
  if (statSync(a).isDirectory()) {
    const names = readdirSync(a);
    for (const n of names) {
      const ext = extname(n).toLowerCase();
      if (![".csv", ".xlsx", ".xls"].includes(ext)) continue;
      if (ext !== ".csv" && names.includes(n.replace(/\.xlsx?$/i, ".csv"))) continue; // prefer the csv twin
      files.push(join(a, n));
    }
  } else files.push(a);
}

const { importFile } = await import("../src/importer.js");
const { pool } = await import("../src/db.js");
let grand = { valid: 0, inserted: 0, updated: 0, skipped: 0 };
for (const f of files) {
  process.stdout.write(`${basename(f)} … `);
  try {
    const r = await importFile(f, { site, dataSource, onProgress: (d, t) => process.stdout.write(`\r${basename(f)} … ${d}/${t}   `) });
    console.log(`\r${basename(f)}: ${r.rows} rows → ${r.valid} valid, ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped  [header=${r.headerRow} map=${JSON.stringify(r.mapping)}]`);
    for (const k of Object.keys(grand)) grand[k] += r[k];
  } catch (e) { console.log(`FAILED: ${e.message}`); }
}
console.log(`\nTOTAL valid ${grand.valid}, new ${grand.inserted}, updated ${grand.updated}, skipped ${grand.skipped}`);
await pool.end();
