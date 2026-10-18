"use strict";
require("dotenv").config();
const fs = require("node:fs");
const { normalizePurchaseEvent } = require("../services/ledger-domain");
const { getLedgerPool, closeLedgerPool } = require("../services/ledger-db");
const { createLedgerStore } = require("../services/ledger-store");
(async () => {
  try {
    const args = process.argv.slice(2);
    const filenames = args.filter(value => value !== "--write");
    const filename = filenames[0];
    if (filenames.length !== 1 || args.filter(value => value === "--write").length > 1
      || args.some(value => value.startsWith("--") && value !== "--write")) throw new Error("usage");
    if (fs.statSync(filename).size > 10 * 1024 * 1024) throw new Error("large");
    const source = fs.readFileSync(filename, "utf8");
    if (Buffer.byteLength(source) > 10 * 1024 * 1024) throw new Error("large");
    let json;
    try { json = JSON.parse(source); }
    catch (_) { json = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    const values = Array.isArray(json) ? json : [json];
    if (!values.length || values.length > 1000) throw new Error("count");
    const events = values.map(value => normalizePurchaseEvent(value, process.env.PLAYFAB_TITLE_ID));
    console.log(`Validated ${events.length} purchase event(s).`);
    if (!args.includes("--write")) { console.log("Dry run only: no database writes. Inspect your exported records, then add --write to import."); return; }
    const results = await createLedgerStore(getLedgerPool()).captureBatch(events);
    console.log(`Imported ${results.filter(result => result.inserted).length} new purchase(s); ${results.filter(result => !result.inserted).length} existing purchase(s) deduplicated.`);
  } catch (error) {
    console.error(error.publicLedgerError ? error.message : "Import failed. Use: npm run ledger:import -- path/to/events.json [--write]. Check the export, title and database connection. No balances were changed.");
    process.exitCode = 1;
  } finally { await closeLedgerPool(); }
})();
