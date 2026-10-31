import "./_env.mjs";
const { migrate, pool } = await import("../src/db.js");
await migrate();
console.log("schema ready");
await pool.end();
