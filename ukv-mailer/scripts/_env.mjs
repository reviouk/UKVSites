// Loads ./.env (and, as a fallback for shared secrets, the sibling Instantly
// connector's .env) into process.env without clobbering values already set.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
for (const p of [join(here, "..", ".env"), join(here, "..", "..", "UKV Instantly Hubspot", ".env")]) {
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m || line.trimStart().startsWith("#")) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
      if (process.env[m[1]] === undefined && v !== "") process.env[m[1]] = v;
    }
  } catch { /* optional */ }
}
