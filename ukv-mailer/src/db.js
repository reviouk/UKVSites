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

// Runs schema.sql on boot. During a deploy the old instance is still sending, and the ALTER TABLEs
// need exclusive locks, so a deadlock (40P01) or lock timeout (55P03) is retried instead of crashing.
export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query("SET lock_timeout = '10s'");
      await c.query(sql);
      return;
    } catch (e) {
      if (!["40P01", "55P03"].includes(e.code) || attempt >= 8) throw e;
      console.warn(`[db] schema busy (${e.code}), retry ${attempt}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    } finally {
      await c.query("RESET lock_timeout").catch(() => {});
      c.release();
    }
  }
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
