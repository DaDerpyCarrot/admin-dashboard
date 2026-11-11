"use strict";
require("dotenv").config({ quiet: true });
const fs = require("node:fs/promises");
const path = require("node:path");
const { getLedgerPool, closeLedgerPool } = require("../services/ledger-db");
async function init() {
  const schema = await fs.readFile(path.join(__dirname, "../db/support-schema.sql"), "utf8");
  const client = await getLedgerPool().connect();
  let discard = false;
  try { await client.query("BEGIN"); await client.query(schema); await client.query("COMMIT"); }
  catch (error) { try { await client.query("ROLLBACK"); } catch (_) { discard = true; } throw error; }
  finally { client.release(discard); }
}
init().then(() => console.log("Support Desk tables and indexes are ready. Existing game, ledger, Company and admin records were not changed."))
  .catch(() => { console.error("Support setup failed. Check the intended DATABASE_URL, TLS settings and database permissions."); process.exitCode = 1; })
  .finally(() => closeLedgerPool().catch(() => { console.error("Could not close the support setup connection cleanly."); process.exitCode = 1; }));
