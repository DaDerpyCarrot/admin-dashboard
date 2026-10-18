const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePurchaseEvent, parseQuery, signCursor, readCursor } = require("../services/ledger-domain");
function event(extra = {}) {
  return { TitleId: "1E22BA", EventId: "33de32ed34f04f3aa62589c5e793e71b", EventName: "player_vc_item_purchased",
    EventNamespace: "com.playfab", Source: "PlayFab", SourceType: "BackEnd", EntityType: "player",
    EntityId: "D7E70BF279A8E13B", Timestamp: "2026-10-13T07:08:08.6044562Z", PurchaseId: "F915E32BA80E26CE",
    ItemId: "cash-tier-09", CatalogVersion: "currency-shop", UnitPrice: 2800, Quantity: 1, CurrencyCode: "CC", ...extra };
}
test("normalizes the verified sample without storing unrelated private data", () => {
  const row = normalizePurchaseEvent(event({ Email: "DO-NOT-STORE", IPAddress: "DO-NOT-STORE", Receipt: "DO-NOT-STORE" }), "1E22BA");
  assert.equal(row.total, "2800"); assert.equal(row.playerId, "D7E70BF279A8E13B");
  assert.equal(row.occurredAt, "2026-10-13T07:08:08.6044562Z");
  assert.equal(row.fingerprint.length, 64);
  assert.ok(!JSON.stringify(row).includes("DO-NOT-STORE"));
});
test("integer totals stay exact even beyond JavaScript's safe-number range", () => {
  const row = normalizePurchaseEvent(event({ UnitPrice: 4294967295, Quantity: 2147483647 }), "1E22BA");
  assert.equal(row.total, (4294967295n * 2147483647n).toString());
});
for (const [label, extra] of [
  ["wrong title", { TitleId: "BAD123" }], ["client-generated event", { SourceType: "Client" }],
  ["custom namespace", { EventNamespace: "mygame" }], ["wrong event", { EventName: "player_virtual_currency_balance_changed" }],
  ["bad event ID", { EventId: "short" }], ["invalid player", { EntityId: "../other" }],
  ["negative price", { UnitPrice: -1 }], ["fractional price", { UnitPrice: 1.5 }],
  ["no quantity", { Quantity: 0 }], ["fractional quantity", { Quantity: .5 }],
  ["invalid day", { Timestamp: "2026-02-31T00:00:00Z" }], ["missing UTC", { Timestamp: "2026-10-13T07:08:08" }]
]) test(`rejects ${label}`, () => assert.throws(() => normalizePurchaseEvent(event(extra), "1E22BA")));
test("zero-price/free purchases are valid", () => assert.equal(normalizePurchaseEvent(event({ UnitPrice: 0 }), "1E22BA").total, "0"));
test("history fields cannot choose another player or include duplicate/array query values", () => {
  assert.throws(() => parseQuery({ playFabId: "OTHER" }));
  assert.throws(() => parseQuery({ currency: ["CC", "CA"] }));
  assert.throws(() => parseQuery({ limit: "1000" }));
  assert.throws(() => parseQuery({ from: "2026-10-15T00:00:00Z", before: "2026-10-14T00:00:00Z" }));
});
test("cursors are signed, title/player/filter-bound and retain microsecond precision", () => {
  const key = "TEST-ONLY-KEY".repeat(4);
  const filter = parseQuery({ currency: "CC" }).filter;
  const value = { v: 1, title: "1E22BA", owner: "D7E70BF279A8E13B", filter, snapshot: "25", id: "20", at: "2026-10-13T07:08:08.604456Z" };
  const cursor = signCursor(value, key);
  assert.deepEqual(readCursor(cursor, key, value.owner, value.title, filter), value);
  assert.throws(() => readCursor(cursor + "x", key, value.owner, value.title, filter));
  assert.throws(() => readCursor(cursor, key, "AAAA", value.title, filter));
  assert.throws(() => readCursor(cursor, key, value.owner, "OTHER", filter));
  assert.throws(() => readCursor(cursor, key, value.owner, value.title, parseQuery({ currency: "GC" }).filter));
});
module.exports = { event };
