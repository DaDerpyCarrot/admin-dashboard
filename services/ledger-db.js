"use strict";
const { ledgerError } = require("./ledger-domain");
let pool;
function getLedgerPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw ledgerError("Transaction storage is not configured yet. Complete the ledger database setup.", 503, "LEDGER_NOT_CONFIGURED");
  const { Pool } = require("pg");
  // Use the database provider's connection URL/TLS settings; do not disable
  // certificate validation globally. Render internal URLs work in its network.
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4,
    connectionTimeoutMillis: 8000, query_timeout: 8000, statement_timeout: 6000 });
  pool.on("error", () => console.warn("Ledger database connection interrupted."));
  return pool;
}
async function closeLedgerPool() { if (pool) { await pool.end(); pool = null; } }
module.exports = { getLedgerPool, closeLedgerPool };
