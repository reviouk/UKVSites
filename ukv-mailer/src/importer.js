/**
 * Spreadsheet importer. Accepts CSV or XLSX, with or without a header row, and
 * maps columns by name heuristics (or by position/content for headerless files).
 * Upserts into contacts by lower-cased email; existing non-blank fields are kept.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { pool } from "./db.js";

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}$/i;

const HEADER_MAP = [
  ["email", /^(e-?mail|email ?address|emailaddress|lead_email)$/i],
  ["first_name", /^(first ?name|firstname|first|forename|first namer|given ?name)$/i],
  ["last_name", /^(last ?name|lastname|last|surname|family ?name)$/i],
  ["full_name", /^(name|full ?name|fullname|contact ?name)$/i],
  ["phone", /^(phone|phone ?number|phone_number|tel|telephone|tel ?number|mobile|mobile ?number|cell|direct ?dial)$/i],
  ["company", /^(company|company ?name|organisation|organization|employer)$/i],
  ["job_title", /^(job ?title|title|position|role)$/i],
  ["postcode", /^(post ?code|postal ?code|postal_code|zip|zip ?code)$/i],
  ["data_source", /^(data ?source|datasource|source)$/i],
  ["phone_code", /^(phone_code|country ?code|dial ?code)$/i],
];

export function readRows(filePath, buffer) {
  const ext = extname(filePath).toLowerCase();
  const buf = buffer || readFileSync(filePath);
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }).map(r => r.map(c => String(c ?? "").trim()));
  }
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true, relax_quotes: true, trim: true });
}

/** Returns { mapping: {field: colIndex}, headerRow: bool } */
const normHeader = (h) => String(h).trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");

export function detectColumns(rows) {
  // Skip leading blank/near-empty rows (some exports start with ",,,,").
  let firstIdx = rows.findIndex(r => r.filter(c => String(c).trim()).length >= 2);
  if (firstIdx < 0) firstIdx = 0;
  const first = rows[firstIdx] || [];
  const headerRow = !first.some(c => EMAIL_RE.test(c));
  const mapping = {};
  if (headerRow) {
    first.forEach((h, i) => {
      const name = normHeader(h);
      for (const [field, re] of HEADER_MAP) {
        if (re.test(name) && mapping[field] == null) { mapping[field] = i; break; }
      }
    });
  }
  if (mapping.email == null) {
    // Content-based: pick the column most often containing an email.
    const sample = rows.slice(headerRow ? firstIdx + 1 : firstIdx, firstIdx + 200);
    const width = Math.max(...sample.map(r => r.length), 0);
    let best = -1, bestN = 0;
    for (let i = 0; i < width; i++) {
      const n = sample.filter(r => EMAIL_RE.test(r[i] || "")).length;
      if (n > bestN) { best = i; bestN = n; }
    }
    if (best >= 0) mapping.email = best;
    if (!headerRow && mapping.first_name == null) {
      // Headerless convention seen in the GM files: first, last, email, phone, postcode
      const textCols = [];
      for (let i = 0; i < mapping.email; i++) {
        const vals = sample.map(r => r[i] || "").filter(Boolean);
        if (vals.length && vals.every(v => /^[a-z' -]+$/i.test(v))) textCols.push(i);
      }
      if (textCols.length >= 2) { mapping.first_name = textCols[0]; mapping.last_name = textCols[1]; }
      else if (textCols.length === 1) mapping.full_name = textCols[0];
      for (let i = 0; i < width; i++) {
        if (i === mapping.email || i === mapping.first_name || i === mapping.last_name) continue;
        const vals = sample.map(r => r[i] || "").filter(Boolean);
        if (!vals.length) continue;
        if (mapping.phone == null && vals.filter(v => /^[\d+()\s-]{7,}$/.test(v)).length > vals.length * 0.7) mapping.phone = i;
        else if (mapping.postcode == null && vals.filter(v => UK_POSTCODE_RE.test(v)).length > vals.length * 0.7) mapping.postcode = i;
      }
    }
  }
  return { mapping, headerRow, firstIdx };
}

export function normPhone(raw, code) {
  if (!raw) return "";
  let d = String(raw).replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("0044")) d = d.slice(4);
  else if (d.startsWith("44") && d.length >= 12) d = d.slice(2);
  if (d.length === 10 && !d.startsWith("0")) d = "0" + d;
  if (d.length === 11 && d.startsWith("0")) return d;      // UK national
  if (code && code !== "44") return `+${code}${d.replace(/^0/, "")}`;
  return d.length >= 8 ? d : "";
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts.slice(1).join(" ")];
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Import one file. opts: { site, dataSource (override), onProgress }
 * Returns { file, rows, valid, inserted, updated, skipped, mapping, headerRow }
 */
export async function importFile(filePath, opts = {}, buffer) {
  const file = basename(filePath);
  const rows = readRows(filePath, buffer);
  const { mapping, headerRow, firstIdx } = detectColumns(rows);
  if (mapping.email == null) throw new Error(`${file}: could not find an email column`);
  const body = rows.slice(headerRow ? firstIdx + 1 : firstIdx);
  const defaultSource = opts.dataSource || file.replace(/\.(csv|xlsx|xls)$/i, "").replace(/\s+/g, " ").trim();

  const seen = new Set();
  const records = [];
  let skipped = 0;
  for (const r of body) {
    const email = clean(r[mapping.email]).toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) { skipped++; continue; }
    seen.add(email);
    let first = clean(r[mapping.first_name]), last = clean(r[mapping.last_name]);
    if (!first && mapping.full_name != null) [first, last] = splitName(r[mapping.full_name]);
    if (/^(mr|mrs|ms|miss|dr)\.?$/i.test(first) && last) { const [f, l] = splitName(last); first = f; last = l; }
    records.push({
      email, first_name: first.slice(0, 80), last_name: last.slice(0, 80),
      company: clean(r[mapping.company]).slice(0, 200),
      job_title: clean(r[mapping.job_title]).slice(0, 200),
      phone: normPhone(r[mapping.phone], clean(r[mapping.phone_code])),
      postcode: clean(r[mapping.postcode]).toUpperCase().slice(0, 12),
      data_source: (clean(r[mapping.data_source]) || defaultSource).slice(0, 120),
      site: opts.site || null,
      source_file: file,
    });
  }

  let inserted = 0, updated = 0;
  const client = await pool.connect();
  try {
    for (let i = 0; i < records.length; i += 1000) {
      const chunk = records.slice(i, i + 1000);
      const cols = ["email", "first_name", "last_name", "company", "job_title", "phone", "postcode", "data_source", "site", "source_file"];
      const values = [];
      const params = [];
      chunk.forEach((rec, j) => {
        values.push(`(${cols.map((_, k) => `$${j * cols.length + k + 1}`).join(",")})`);
        params.push(...cols.map(c => rec[c] || null));
      });
      const res = await client.query(`
        INSERT INTO contacts(${cols.join(",")}) VALUES ${values.join(",")}
        ON CONFLICT (email) DO UPDATE SET
          first_name = COALESCE(NULLIF(contacts.first_name,''), EXCLUDED.first_name),
          last_name  = COALESCE(NULLIF(contacts.last_name,''),  EXCLUDED.last_name),
          company    = COALESCE(NULLIF(contacts.company,''),    EXCLUDED.company),
          job_title  = COALESCE(NULLIF(contacts.job_title,''),  EXCLUDED.job_title),
          phone      = COALESCE(NULLIF(contacts.phone,''),      EXCLUDED.phone),
          postcode   = COALESCE(NULLIF(contacts.postcode,''),   EXCLUDED.postcode),
          site       = COALESCE(contacts.site, EXCLUDED.site),
          updated_at = now()
        RETURNING (xmax = 0) AS inserted`, params);
      for (const row of res.rows) row.inserted ? inserted++ : updated++;
      opts.onProgress?.(i + chunk.length, records.length);
    }
  } finally { client.release(); }
  return { file, rows: body.length, valid: records.length, inserted, updated, skipped, mapping, headerRow };
}
