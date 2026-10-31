import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }

// Render Postgres needs SSL from outside Render; the internal URL works either way.
const ssl = /render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
export const pool = new Pool({ connectionString: url, ssl, max: 10 });

export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
export const all = async (text, params) => (await pool.query(text, params)).rows;

export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function getSetting(key, fallback = null) {
  const r = await one("SELECT value FROM settings WHERE key=$1", [key]);
  return r ? r.value : fallback;
}
export async function setSetting(key, value) {
  await q(
    "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [key, String(value)],
  );
}
