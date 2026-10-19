"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createAdminTransactionsRouter } = require("../routes/admin-transactions");
const { signCursor, parseQuery } = require("../services/ledger-domain");
const OWNER = "A123B456C789D012", OTHER = "B123C456D789E012";
const KEY = "0".repeat(64), SECRET = "local-test-secret-never-a-production-credential";
const admins = [{ username: "testadmin", playFabId: "A11CE123" }, { username: "otheradmin", playFabId: "B0B123" }];
function runModule(file, requireMock) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports,
    require: requireMock, console, process: { env: { ADMIN_JWT_SECRET: SECRET } } }, { filename: file });
  return module.exports;
}
const verifyAdminToken = runModule(path.resolve(__dirname, "../middleware/verifyAdminToken.js"), name => {
  if (name === "jsonwebtoken") return jwt;
  if (name === "../services/adminAccounts") return { findActiveAdminByUsername: username => admins.find(row => row.username === username),
    normalizePlayFabId: value => String(value || "").trim().toUpperCase() };
  throw new Error("Unexpected auth dependency");
});
const token = (payload = {}, options = {}) => jwt.sign({ username: "testadmin", playFabId: "A11CE123", role: "admin", ...payload }, SECRET, { expiresIn: "10m", ...options });
function row(id, owner, extra = {}) {
  return { id: String(id), player_id: owner, title_id: "1E22BA", item_id: "industrytokens-tier-02", purchase_id: "ORDER" + id,
    catalog_version: "currency-shop", currency_code: "CC", unit_price: "195", quantity: "1", total_price: "195",
    original_timestamp: `2026-10-11T14:18:2${id}.6823459Z`, page_timestamp: `2026-10-11T14:18:2${id}.682346Z`, ...extra };
}
async function fixture(t, { mountMain = false } = {}) {
  const state = { calls: [], names: [], clock: Date.parse("2026-10-18T12:00:00Z"),
    rows: [row(3, OWNER), row(2, OWNER, { item_id: "removed-item" }), row(1, OTHER)], key: KEY, title: "1E22BA" };
  const deps = { verifyAdminToken,
    settings: () => ({ title: state.title, key: state.key }), now: () => state.clock, logger: () => {},
    store: () => ({
      capture: () => { throw new Error("A read-only route attempted a write"); },
      async list(args) {
        state.calls.push(args);
        if (state.storeError) throw new Error("postgres://private-user:private-password@private-host/raw-query");
        const all = state.rows.filter(row => row.player_id === args.owner && row.title_id === args.title);
        let matches = all.filter(row => (!args.filter.currency || row.currency_code === args.filter.currency)
          && (!args.filter.from || Date.parse(row.original_timestamp) >= Date.parse(args.filter.from))
          && (!args.filter.before || Date.parse(row.original_timestamp) < Date.parse(args.filter.before))
          && (!args.filter.q || `${row.item_id} ${row.purchase_id}`.toLowerCase().includes(args.filter.q.toLowerCase())));
        if (args.page) matches = matches.filter(row => BigInt(row.id) < BigInt(args.page.id));
        return { rows: matches.slice(0, args.limit), currencies: [...new Set(all.map(row => row.currency_code))],
          snapshot: "3", hasMore: matches.length > args.limit };
      }
    }),
    catalog: async version => {
      state.names.push(version);
      if (state.catalogError) throw new Error("private catalog error");
      return { data: { Catalog: [{ ItemId: "industrytokens-tier-02", DisplayName: "Workshop Pair" }] } };
    }
  };
  const app = express();
  if (mountMain) {
    const main = runModule(path.resolve(__dirname, "../routes/admin.js"), name => {
      if (name === "express") return express;
      if (name === "jsonwebtoken") return jwt;
      if (name === "bcryptjs") return {};
      if (name === "../middleware/verifyAdminToken") return verifyAdminToken;
      if (name === "../services/adminAccounts") return { loadAdmins: () => [] };
      if (name === "./admin-friends") return { createAdminFriendsRouter: () => express.Router() };
      if (name === "./admin-transactions") return { createAdminTransactionsRouter: options => { assert.equal(options.verifyAdminToken, verifyAdminToken); return createAdminTransactionsRouter(deps); } };
      if (name === "../services/adminFriends") return { sanitizeAdminInternalData: value => value };
      if (name === "../services/playfab") return {};
      throw new Error("Unexpected main-router dependency " + name);
    });
    app.use("/api/admin", main);
  } else app.use("/api/admin", createAdminTransactionsRouter(deps));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const req = async (owner = OWNER, { auth = token(), query = "", method = "GET" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/player/${owner}/transactions${query}`, {
      method, headers: auth ? { Authorization: "Bearer " + auth } : {}
    });
    const raw = await response.text(); let data;
    try { data = JSON.parse(raw); } catch (_) {}
    return { response, data, raw };
  };
  return { state, req };
}

test("admin ledger authentication rejects unauthorized sessions before storage reads", async t => {
  const { state, req } = await fixture(t);
  for (const [label, auth, status] of [
    ["missing JWT", null, 401], ["invalid JWT", "invalid", 401],
    ["player session ticket", "PLAYFAB_PLAYER_SESSION_TICKET", 401],
    ["expired JWT", token({}, { expiresIn: -1 }), 401],
    ["player role", token({ role: "player" }), 403],
    ["inactive administrator", token({ username: "inactive" }), 403],
    ["mismatched admin identity", token({ playFabId: "BAD123" }), 403]
  ]) await t.test(label, async () => {
    const result = await req(OWNER, { auth });
    assert.equal(result.response.status, status);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(state.calls.length, 0); assert.equal(state.names.length, 0);
  });
});

test("authorized admin reads only the selected player's captured records", async t => {
  const { state, req } = await fixture(t);
  const result = await req(OWNER.toLowerCase());
  assert.equal(result.response.status, 200); assert.equal(result.data.playerId, OWNER);
  assert.equal(result.data.transactions.length, 2); assert.equal(result.data.readOnly, true);
  assert.equal(result.data.transactions[0].total, "195"); assert.equal(result.data.transactions[0].itemName, "Workshop Pair");
  assert.equal(result.data.transactions[1].itemName, null); assert.equal(result.data.transactions[1].labelSource, "item_id_only");
  assert.equal(result.data.coverage.type, "legacy_virtual_currency_purchase");
  assert.equal(state.calls[0].owner, OWNER); assert.equal(state.calls[0].title, "1E22BA");
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  for (const forbidden of [KEY, "fingerprint", "private-password", "RoadPurchaseOutbox_", "SessionTicket"]) assert.ok(!result.raw.includes(forbidden));
  assert.equal((await req(OTHER)).data.transactions.length, 1);
  assert.equal((await req("ABC123")).data.transactions.length, 0);
});

test("history query validation never broadens the selected owner", async t => {
  const { state, req } = await fixture(t);
  for (const query of ["?playerId=" + OTHER, "?owner=" + OTHER, "?currency=CC&currency=GC", "?q[]=x",
    "?limit=100", "?from=not-a-date", "?from=2026-10-13T00:00:00Z&before=2026-10-12T00:00:00Z", "?cursor=forged"]) {
    assert.equal((await req(OWNER, { query })).response.status, 400);
  }
  assert.equal((await req("not_hex")).response.status, 400);
  assert.equal(state.calls.length, 0);
  const query = "?limit=1&currency=CC&from=2026-10-11T00%3A00%3A00Z&before=2026-10-12T00%3A00%3A00Z&q=ORDER3";
  assert.equal((await req(OWNER, { query })).data.transactions.length, 1);
  assert.equal(state.calls.at(-1).filter.q, "ORDER3");
  assert.equal(state.calls.at(-1).filter.before, "2026-10-12T00:00:00Z");
});

test("admin cursors are bound to actor, selected player, title and filters, not player-profile cursors", async t => {
  const { state, req } = await fixture(t);
  const first = await req(OWNER, { query: "?limit=1" });
  assert.ok(first.data.nextCursor);
  const page = "?limit=1&cursor=" + encodeURIComponent(first.data.nextCursor);
  const second = await req(OWNER, { query: page });
  assert.equal(second.response.status, 200); assert.equal(second.data.transactions[0].id, "2");
  assert.equal((await req(OTHER, { query: page })).response.status, 400);
  assert.equal((await req(OWNER, { query: page + "&currency=CC" })).response.status, 400);
  assert.equal((await req(OWNER, { query: page, auth: token({ username: "otheradmin", playFabId: "B0B123" }) })).response.status, 400);
  state.title = "ABC123"; assert.equal((await req(OWNER, { query: page })).response.status, 400); state.title = "1E22BA";
  const playerCursor = signCursor({ v: 1, title: "1E22BA", owner: OWNER, filter: parseQuery({}).filter,
    snapshot: "3", id: "3", at: "2026-10-11T14:18:23.682346Z" }, KEY);
  assert.equal((await req(OWNER, { query: "?cursor=" + encodeURIComponent(playerCursor) })).response.status, 400);
});

test("catalog name failures preserve IDs and costs; names are cached briefly", async t => {
  const { state, req } = await fixture(t);
  state.catalogError = true;
  let result = await req();
  assert.equal(result.response.status, 200); assert.equal(result.data.catalogNamesUnavailable, true);
  assert.equal(result.data.transactions[0].itemId, "industrytokens-tier-02"); assert.equal(result.data.transactions[0].total, "195");
  state.catalogError = false; await req(); assert.equal(state.names.length, 1);
  state.clock += 300001;
  result = await req(); assert.equal(result.data.transactions[0].itemName, "Workshop Pair"); assert.equal(state.names.length, 2);
});

test("database/setup failures are not reported as an empty ledger and do not leak diagnostics", async t => {
  const { state, req } = await fixture(t);
  state.storeError = true;
  const failed = await req(); assert.equal(failed.response.status, 503);
  assert.ok(!failed.raw.includes("private-password")); assert.ok(!failed.raw.includes("private-host"));
  assert.ok(!Object.hasOwn(failed.data, "transactions"));
  state.storeError = false; state.key = "";
  assert.equal((await req()).response.status, 503);
});

test("admin ledger offers no write, refund, balance-change or replay operation", async t => {
  const { state, req } = await fixture(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await req(OWNER, { method })).response.status, 404);
  assert.equal(state.calls.length, 0);
});

test("admin rate limits are per administrator and reset each minute", async t => {
  const { state, req } = await fixture(t);
  for (let i = 0; i < 60; i++) assert.equal((await req()).response.status, 200);
  const limited = await req(); assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get("retry-after"), "60");
  assert.equal(state.calls.length, 60);
  assert.equal((await req(OWNER, { auth: token({ username: "otheradmin", playFabId: "B0B123" }) })).response.status, 200);
  state.clock += 60001; assert.equal((await req()).response.status, 200);
});

test("existing admin router mounts the new protected route", async t => {
  const { req } = await fixture(t, { mountMain: true });
  assert.equal((await req()).response.status, 200);
  assert.equal((await req(OWNER, { auth: null })).response.status, 401);
});
