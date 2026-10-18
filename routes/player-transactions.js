"use strict";
const express = require("express");
const crypto = require("node:crypto");
const { COVERAGE, ledgerError, playerId, normalizePurchaseEvent, parseQuery, signCursor, readCursor } = require("../services/ledger-domain");
const { getLedgerPool } = require("../services/ledger-db");
const { createLedgerStore } = require("../services/ledger-store");

function timeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(ledgerError("PlayFab is taking too long. Please retry.", 503)), ms); })]).finally(() => clearTimeout(timer));
}
function createPlayerTransactionsRouter({ settings, store, authenticate, catalog, logger = () => {}, now = () => Date.now() }) {
  const router = express.Router();
  const labelCache = new Map();
  const readWindows = new Map();
  function admitRead(ticket, res) {
    // A modest process-local limit, keyed by a hash rather than stored tickets.
    // Do not use req.ip here: proxy configuration can group unrelated players.
    const token = crypto.createHash("sha256").update(ticket).digest("hex");
    const time = now();
    let window = readWindows.get(token);
    if (!window || time - window.start >= 60000) window = { start: time, count: 0 };
    if (window.count >= 30) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((60000 - time + window.start) / 1000))));
      throw ledgerError("Too many history requests. Wait a minute before refreshing.", 429, "LEDGER_RATE_LIMIT");
    }
    window.count++;
    readWindows.delete(token); readWindows.set(token, window);
    if (readWindows.size > 2000) readWindows.delete(readWindows.keys().next().value);
  }
  function fail(res, error) {
    logger(error.code || "LEDGER_UNAVAILABLE");
    res.status(error.publicLedgerError ? error.status : 503).json({ ok: false,
      message: error.publicLedgerError ? error.message : "Transaction history is unavailable. Complete database setup or retry shortly." });
  }
  function config() {
    const value = settings();
    if (!value.title || !value.key || value.key.length < 32) throw ledgerError("Transaction history is not configured yet. Complete the ledger setup.", 503, "LEDGER_NOT_CONFIGURED");
    return { title: value.title.trim().toUpperCase(), key: value.key };
  }
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.post("/transactions/playfab-events", async (req, res) => {
    try {
      const cfg = config();
      const header = req.headers.authorization || "";
      const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
      const hash = value => crypto.createHash("sha256").update(value).digest();
      if (!supplied || supplied.length > 512 || !crypto.timingSafeEqual(hash(supplied), hash(cfg.key))) throw ledgerError("Purchase-event authentication is required.", 401);
      const event = normalizePurchaseEvent(req.body, cfg.title);
      const result = await store().capture(event);
      // The forwarder only deletes its private outbox after this durable receipt.
      res.json({ ok: true, eventId: event.eventId, saved: true, duplicate: !result.inserted });
    } catch (error) { fail(res, error); }
  });
  router.get("/player/transactions", async (req, res) => {
    try {
      const cfg = config();
      const header = req.headers.authorization || "";
      const ticket = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (ticket.length < 20 || ticket.length > 4096) throw ledgerError("Sign in again to view your transaction history.", 401);
      admitRead(ticket, res);
      let result;
      try { result = await timeout(authenticate(ticket), 10000); }
      catch (error) {
        if (error.status && error.status < 500) throw ledgerError("Your player session is invalid or expired. Sign in again.", 401);
        throw ledgerError("Your player session could not be checked. Retry shortly.", 503);
      }
      if (result?.data?.IsSessionTicketExpired) throw ledgerError("Your player session expired. Sign in again.", 401);
      let owner;
      try { owner = playerId(result?.data?.UserInfo?.PlayFabId); }
      catch (_) { throw ledgerError("Your player identity could not be verified. Sign in again.", 401); }
      const { filter, limit, cursor } = parseQuery(req.query);
      const page = readCursor(cursor, cfg.key, owner, cfg.title, filter);
      const data = await store().list({ title: cfg.title, owner, filter, limit, page });
      const labels = new Map();
      await Promise.all([...new Set(data.rows.map(row => row.catalog_version))].map(async version => {
        let cached = labelCache.get(version);
        if (!cached || Date.now() - cached.at > 300000) {
          try {
            const response = await timeout(catalog(version), 3000);
            cached = { at: Date.now(), items: new Map((response?.data?.Catalog || []).map(item => [item.ItemId, typeof item.DisplayName === "string" ? item.DisplayName.slice(0, 200) : ""])) };
          } catch (_) { cached = { at: Date.now(), items: new Map() }; }
          if (labelCache.size > 100) labelCache.clear();
          labelCache.set(version, cached);
        }
        labels.set(version, cached.items);
      }));
      const transactions = data.rows.map(row => ({
        id: row.id, eventType: COVERAGE.type, purchaseId: row.purchase_id,
        itemId: row.item_id, catalogVersion: row.catalog_version,
        itemName: labels.get(row.catalog_version)?.get(row.item_id) || null,
        labelSource: labels.get(row.catalog_version)?.get(row.item_id) ? "current_catalog" : "item_id_only",
        currency: row.currency_code, unitPrice: row.unit_price, quantity: row.quantity,
        total: row.total_price, occurredAt: row.original_timestamp,
        status: "recorded_purchase"
      }));
      const last = data.rows[data.rows.length - 1];
      const nextCursor = data.hasMore && last ? signCursor({ v: 1, title: cfg.title, owner, filter,
        snapshot: data.snapshot, at: last.page_timestamp, id: last.id }, cfg.key) : null;
      res.json({ ok: true, playerId: owner, transactions, currencies: data.currencies,
        nextCursor, coverage: COVERAGE, fetchedAt: new Date().toISOString() });
    } catch (error) { fail(res, error); }
  });
  return router;
}
function defaultRouter() {
  return createPlayerTransactionsRouter({
    settings: () => ({ title: process.env.PLAYFAB_TITLE_ID, key: process.env.LEDGER_INGEST_KEY }),
    store: () => createLedgerStore(getLedgerPool()),
    authenticate: ticket => require("../services/playfab").authenticateSessionTicket(ticket),
    catalog: version => require("../services/playfab").callPlayFab("/Server/GetCatalogItems", { CatalogVersion: version }),
    logger: code => console.warn("Ledger request:", code)
  });
}
module.exports = { createPlayerTransactionsRouter, defaultRouter };
