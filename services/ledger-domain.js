"use strict";
const crypto = require("node:crypto");
const COVERAGE = Object.freeze({
  version: 1,
  type: "legacy_virtual_currency_purchase",
  description: "Captured PlayFab legacy virtual-currency purchases only. This is not yet all game spending or payment history.",
  excluded: ["PayMongo payments", "contract-budget/material spending", "pending or failed purchase attempts"]
});

function ledgerError(message, status = 400, code = "LEDGER_INVALID_INPUT") {
  return Object.assign(new Error(message), { status, code, publicLedgerError: true });
}
function text(value, label, max = 128) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw ledgerError(`Invalid ${label}.`);
  }
  return value.trim();
}
function playerId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{3,64}$/i.test(value)) throw ledgerError("Invalid player ID.");
  return value.toUpperCase();
}
function utc(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw ledgerError(`Invalid ${label}. Use a UTC timestamp.`);
  }
  return value;
}
function currency(value) {
  if (typeof value !== "string" || !/^[A-Z0-9_-]{1,8}$/.test(value)) throw ledgerError("Invalid currency code.");
  return value;
}
function normalizePurchaseEvent(input, expectedTitleId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw ledgerError("Send one purchase event object.");
  if (input.EventName !== "player_vc_item_purchased" || input.EventNamespace !== "com.playfab"
    || input.Source !== "PlayFab" || input.SourceType !== "BackEnd" || input.EntityType !== "player") {
    throw ledgerError("Only PlayFab backend virtual-currency purchase events are accepted.");
  }
  const title = text(input.TitleId, "title ID", 32).toUpperCase();
  if (title !== String(expectedTitleId || "").toUpperCase()) throw ledgerError("The purchase belongs to a different title.");
  if (typeof input.EventId !== "string" || !/^[a-f0-9]{32}$/i.test(input.EventId)) throw ledgerError("Invalid event ID.");
  if (!Number.isInteger(input.UnitPrice) || input.UnitPrice < 0 || input.UnitPrice > 4294967295) throw ledgerError("Invalid unit price.");
  if (!Number.isInteger(input.Quantity) || input.Quantity < 1 || input.Quantity > 2147483647) throw ledgerError("Invalid quantity.");
  const row = {
    titleId: title,
    eventId: input.EventId.toLowerCase(),
    playerId: playerId(input.EntityId),
    purchaseId: text(input.PurchaseId, "purchase ID"),
    itemId: text(input.ItemId, "item ID", 256),
    catalogVersion: typeof input.CatalogVersion === "string" && !input.CatalogVersion.length ? "" : text(input.CatalogVersion, "catalog version"),
    currency: currency(input.CurrencyCode),
    unitPrice: String(input.UnitPrice),
    quantity: String(input.Quantity),
    total: (BigInt(input.UnitPrice) * BigInt(input.Quantity)).toString(),
    occurredAt: utc(input.Timestamp, "purchase timestamp")
  };
  row.fingerprint = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
  // Only curated fields survive. No IP addresses, receipts, email, metadata or keys.
  return row;
}
function parseQuery(query) {
  const keys = new Set(["limit", "currency", "from", "before", "q", "cursor"]);
  if (Object.keys(query).some(key => !keys.has(key))) throw ledgerError("Unsupported history query field.");
  if (Object.values(query).some(value => typeof value !== "string")) throw ledgerError("History query fields must be single values.");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw ledgerError("Page size must be 1–50.");
  const filter = {
    currency: query.currency ? currency(query.currency) : "",
    from: query.from ? utc(query.from, "start date") : "",
    before: query.before ? utc(query.before, "end date") : "",
    q: query.q ? text(query.q, "item/purchase search", 100) : ""
  };
  if (filter.from && filter.before && Date.parse(filter.from) >= Date.parse(filter.before)) throw ledgerError("The end date must follow the start date.");
  if (query.cursor && query.cursor.length > 4096) throw ledgerError("Invalid page cursor.");
  return { limit, filter, cursor: query.cursor || "" };
}
function signCursor(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", key).update("road-ledger-page-v1:" + encoded).digest("base64url")}`;
}
function readCursor(value, key, owner, title, filter) {
  if (!value) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 2) throw new Error();
    const expected = crypto.createHmac("sha256", key).update("road-ledger-page-v1:" + parts[0]).digest();
    const signature = Buffer.from(parts[1], "base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) throw new Error();
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (data.v !== 1 || data.owner !== owner || data.title !== title || JSON.stringify(data.filter) !== JSON.stringify(filter)
      || !/^[0-9]{1,19}$/.test(data.id) || !/^[0-9]{1,19}$/.test(data.snapshot)) throw new Error();
    utc(data.at, "page timestamp");
    return data;
  } catch (_) { throw ledgerError("This page cursor is invalid for the selected account/filters. Refresh the ledger."); }
}
module.exports = { COVERAGE, ledgerError, playerId, utc, normalizePurchaseEvent, parseQuery, signCursor, readCursor };
