"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { COVERAGE, ledgerError, playerId, parseQuery, signCursor, readCursor } = require("../services/ledger-domain");
const { getLedgerPool } = require("../services/ledger-db");
const { createLedgerStore } = require("../services/ledger-store");

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(ledgerError("Catalog lookup timed out.", 503)), ms);
  })]).finally(() => clearTimeout(timer));
}

function createAdminTransactionsRouter({ verifyAdminToken,
  settings = () => ({ title: process.env.PLAYFAB_TITLE_ID, key: process.env.LEDGER_INGEST_KEY }),
  store = () => createLedgerStore(getLedgerPool()),
  catalog = version => require("../services/playfab").callPlayFab("/Server/GetCatalogItems", { CatalogVersion: version }),
  now = () => Date.now(), logger = code => console.warn("Admin ledger request:", code)
}) {
  if (typeof verifyAdminToken !== "function") throw new Error("Admin authentication middleware is required.");
  const router = express.Router();
  const names = new Map();
  const readWindows = new Map();
  const route = "/player/:playFabId/transactions";
  const noCache = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

  // Even rejected credentials on this endpoint must not produce cached data.
  router.get(route, noCache, verifyAdminToken, async (req, res) => {
    try {
      const actor = req.admin;
      if (!actor || actor.role !== "admin" || typeof actor.username !== "string" || !actor.username) {
        throw ledgerError("Administrator access is required.", 403, "LEDGER_ADMIN_REQUIRED");
      }
      const owner = playerId(req.params.playFabId);
      const value = settings();
      if (typeof value?.title !== "string" || !/^[a-f0-9]{1,32}$/i.test(value.title.trim())
        || typeof value.key !== "string" || value.key.length < 32) {
        throw ledgerError("Transaction history is not configured. Check the existing ledger environment settings.", 503, "LEDGER_NOT_CONFIGURED");
      }
      const title = value.title.trim().toUpperCase();
      const { filter, limit, cursor } = parseQuery(req.query);
      const identity = JSON.stringify([actor.username, actor.playFabId || ""]);
      const time = now();
      let window = readWindows.get(identity);
      if (!window || time - window.at >= 60000) window = { at: time, count: 0 };
      if (window.count >= 60) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((60000 - time + window.at) / 1000))));
        throw ledgerError("Too many ledger requests. Wait a minute before refreshing.", 429, "LEDGER_RATE_LIMIT");
      }
      window.count++; readWindows.delete(identity); readWindows.set(identity, window);
      if (readWindows.size > 1000) readWindows.delete(readWindows.keys().next().value);

      // Cursors are bound to admin identity as well as selected player, title
      // and filters. A player-profile cursor cannot be used on this endpoint.
      const cursorKey = crypto.createHmac("sha256", value.key).update("road-admin-ledger-v1:" + identity).digest("hex");
      const page = readCursor(cursor, cursorKey, owner, title, filter);
      // Read only. Never execute a purchase, replay CloudScript, refund, grant,
      // change a balance, or write to the shared transaction store here.
      const data = await store().list({ title, owner, filter, limit, page });
      const catalogs = new Map();
      let unavailable = false;
      await Promise.all([...new Set(data.rows.map(row => row.catalog_version))].map(async version => {
        const key = JSON.stringify([title, version]);
        let entry = names.get(key);
        if (!entry || time - entry.at >= 300000) {
          try {
            const result = await bounded(catalog(version), 3000);
            const items = result?.data?.Catalog;
            if (!Array.isArray(items)) throw new Error("Catalog unavailable");
            entry = { at: time, unavailable: false, items: new Map(items.filter(item => typeof item?.ItemId === "string")
              .map(item => [item.ItemId, typeof item.DisplayName === "string" ? item.DisplayName.slice(0, 200) : ""])) };
          } catch (_) { entry = { at: time, unavailable: true, items: new Map() }; }
          if (names.size >= 100) names.delete(names.keys().next().value);
          names.set(key, entry);
        }
        catalogs.set(version, entry.items);
        unavailable = unavailable || entry.unavailable;
      }));
      const transactions = data.rows.map(row => {
        const itemName = catalogs.get(row.catalog_version)?.get(row.item_id) || null;
        return {
          id: row.id, eventType: COVERAGE.type, purchaseId: row.purchase_id,
          itemId: row.item_id, catalogVersion: row.catalog_version, itemName,
          labelSource: itemName ? "current_catalog" : "item_id_only",
          currency: row.currency_code, unitPrice: row.unit_price, quantity: row.quantity,
          total: row.total_price, occurredAt: row.original_timestamp, status: "recorded_purchase"
        };
      });
      const last = data.rows[data.rows.length - 1];
      const nextCursor = data.hasMore && last ? signCursor({ v: 1, title, owner, filter,
        snapshot: data.snapshot, at: last.page_timestamp, id: last.id }, cursorKey) : null;
      res.json({ ok: true, playerId: owner, transactions, currencies: data.currencies,
        nextCursor, coverage: COVERAGE, fetchedAt: new Date(time).toISOString(), readOnly: true,
        catalogNamesUnavailable: unavailable });
    } catch (error) {
      logger(error.publicLedgerError ? error.code : "LEDGER_READ_UNAVAILABLE");
      res.status(error.publicLedgerError ? error.status : 503).json({ ok: false,
        message: error.publicLedgerError ? error.message : "Transaction history is unavailable. Check the ledger database connection or retry shortly." });
    }
  });
  return router;
}

module.exports = { createAdminTransactionsRouter };
