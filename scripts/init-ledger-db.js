"use strict";
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { getLedgerPool, closeLedgerPool } = require("../services/ledger-db");
(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "../db/ledger-schema.sql"), "utf8");
    await getLedgerPool().query(sql);
    console.log("Ledger tables and indexes are ready. Existing application tables were not changed.");
  } catch (_) { console.error("Ledger initialization failed. Check DATABASE_URL, provider TLS requirements and database permissions."); process.exitCode = 1; }
  finally { await closeLedgerPool(); }
})();
