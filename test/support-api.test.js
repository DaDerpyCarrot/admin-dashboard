"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createSupportRouters } = require("../routes/support");
const d = require("../services/support-domain");
const SECRET = "isolated-support-tests-not-a-production-secret";
const TICKET = "TEST-PLAYER-SESSION-TICKET-00000001";
const OTHER_TICKET = "TEST-PLAYER-SESSION-TICKET-00000002";
const OWNER = "A123B456C789D012", OTHER = "B123C456D789E012";
const report = extra => ({ requestId: randomUUID(), category: "bug", area: "game", subject: "Contract does not finish", description: "The road is repaired but the finish button does not complete the job.", ...extra });
async function fixture(t) {
  const state = { calls: [], authCalls: [], logs: [], title: "1E22BA", records: new Map(), admins: [{ username: "testadmin", isActive: true, playFabId: "ABC123" }], clock: 1000000 };
  const mod = { exports: {} };
  vm.runInNewContext(readFileSync(path.join(__dirname, "../middleware/verifyAdminToken.js"), "utf8"), {
    module: mod, exports: mod.exports, process: { env: { ADMIN_JWT_SECRET: SECRET } },
    require(name) {
      if (name === "jsonwebtoken") return jwt;
      if (name === "../services/adminAccounts") return {
        findActiveAdminByUsername: value => state.admins.find(row => row.username === value && row.isActive),
        normalizePlayFabId: value => String(value || "").toUpperCase()
      };
      throw new Error("Unexpected auth import");
    }
  });
  const check = (ctx, id) => {
    const row = state.records.get(id);
    if (!row || row.title !== ctx.title || (ctx.actor.role !== "admin" && row.owner !== ctx.actor.id)) throw d.missing();
    return row;
  };
  const storage = {
    async create(ctx, data) { state.calls.push({ method: "create", ctx, data }); const id = randomUUID(); const row = { id, owner: ctx.actor.id, title: ctx.title, subject: data.subject }; state.records.set(id, row); return { ticket: { id, subject: data.subject, reference: "RD-000001", status: "open" }, replayed: false }; },
    async list(ctx, filter) { state.calls.push({ method: "list", ctx, filter }); return { tickets: [...state.records.values()].filter(row => row.title === ctx.title && (ctx.actor.role === "admin" || row.owner === ctx.actor.id)).map(row => ({ id: row.id, subject: row.subject })), nextCursor: null }; },
    async get(ctx, id) { state.calls.push({ method: "get", ctx, id }); if (state.storeError) throw state.storeError; return { id: check(ctx, id).id }; },
    async messages(ctx, id, query) { state.calls.push({ method: "messages", ctx, id, query }); check(ctx, id); return { messages: [], nextCursor: null }; },
    async append(ctx, id, data, internal) { state.calls.push({ method: "append", ctx, id, data, internal }); check(ctx, id); return { ticket: { id }, message: { id: randomUUID(), body: data.body }, replayed: false }; },
    async update(ctx, id, data) { state.calls.push({ method: "update", ctx, id, data }); check(ctx, id); return { ticket: { id, status: data.status }, replayed: false }; },
    async activity(ctx, id, query) { state.calls.push({ method: "activity", ctx, id, query }); check(ctx, id); return { activity: [], nextCursor: null }; },
    async summary(ctx) { state.calls.push({ method: "summary", ctx }); return { counts: { open: state.records.size }, total: state.records.size, needsAttention: state.records.size }; }
  };
  const routers = createSupportRouters({
    settings: () => ({ title: state.title }), store: () => storage, now: () => state.clock,
    logger: code => state.logs.push(code), verifyAdminToken: mod.exports, upstreamTimeoutMs: 45,
    async authenticatePlayer(ticket, signal) {
      state.authCalls.push(ticket);
      if (state.holdAuth) return new Promise(() => { signal.addEventListener("abort", () => { state.aborted = true; }); });
      if (state.authError) throw state.authError;
      if (![TICKET, OTHER_TICKET].includes(ticket)) throw { details: { error: "InvalidSessionTicket" } };
      return { data: { IsSessionTicketExpired: Boolean(state.expired), UserInfo: { PlayFabId: ticket === TICKET ? OWNER : OTHER,
        TitleInfo: { DisplayName: "Road Operator" }, PrivateInfo: { Email: "never-store@example.invalid" } } } };
    }
  });
  const app = express();
  app.use("/api/player/support", routers.player);
  app.use("/api/admin/support", routers.admin);
  app.use(express.json()); // Mirrors the production mount order.
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = (extra = {}, secret = SECRET) => jwt.sign({ role: "admin", username: "testadmin", playFabId: "ABC123", ...extra }, secret, { expiresIn: "10m" });
  async function request(suffix = "", { scope = "player", method = "GET", auth = scope === "admin" ? token() : TICKET, body, raw, contentType = "application/json" } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${scope}/support${suffix}`, {
      method, headers: { ...(auth ? { Authorization: "Bearer " + auth } : {}), ...(body !== undefined || raw !== undefined ? { "Content-Type": contentType } : {}) },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {})
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  return { state, request, token };
}

test("support API binds report ownership to the verified session, not a body field", async t => {
  const s = await fixture(t);
  const data = report();
  const result = await s.request("", { method: "POST", body: data });
  assert.equal(result.status, 201);
  assert.equal(s.state.calls[0].ctx.actor.id, OWNER);
  assert.equal(s.state.calls[0].ctx.actor.name, "Road Operator");
  assert.doesNotMatch(JSON.stringify(s.state.calls), /never-store/);
  assert.equal((await s.request("", { method: "POST", body: { ...data, playerId: OTHER } })).status, 400);
  assert.equal((await s.request("?playerId=" + OTHER)).status, 400);
});
test("support API refuses anonymous, forged, expired, and cross-role tokens", async t => {
  const s = await fixture(t);
  assert.equal((await s.request("", { auth: null })).status, 401);
  assert.equal((await s.request("", { auth: "not-a-session-ticket-but-long-enough" })).status, 401);
  assert.equal((await s.request("", { auth: s.token() })).status, 401);
  assert.equal((await s.request("", { scope: "admin", auth: TICKET })).status, 401);
  assert.equal((await s.request("", { scope: "admin", auth: s.token({}, "wrong-secret") })).status, 401);
  s.state.expired = true;
  assert.equal((await s.request()).status, 401);
  assert.equal(s.state.calls.length, 0);
});
test("support admin routes recheck the existing active-admin record", async t => {
  const s = await fixture(t);
  assert.equal((await s.request("/summary", { scope: "admin" })).status, 200);
  assert.equal((await s.request("/summary", { scope: "admin", auth: s.token({ role: "player" }) })).status, 403);
  assert.equal((await s.request("/summary", { scope: "admin", auth: s.token({ playFabId: "DEAD123" }) })).status, 403);
  s.state.admins[0].isActive = false;
  assert.equal((await s.request("/summary", { scope: "admin" })).status, 403);
});
test("another player sees the same not-found response as a nonexistent report", async t => {
  const s = await fixture(t);
  const { data } = await s.request("", { method: "POST", body: report() });
  const id = data.ticket.id;
  assert.equal((await s.request("/" + id, { auth: OTHER_TICKET })).status, 404);
  assert.equal((await s.request("/" + id + "/messages", { auth: OTHER_TICKET })).status, 404);
  assert.equal((await s.request("/" + id + "/replies", { auth: OTHER_TICKET, method: "POST", body: { requestId: randomUUID(), body: "Trying to access another report" } })).status, 404);
  assert.equal((await s.request("/" + id, { scope: "admin" })).status, 200);
});
test("support has separate public-reply and admin-only internal-note paths", async t => {
  const s = await fixture(t);
  const { data } = await s.request("", { method: "POST", body: report() });
  const id = data.ticket.id, message = { requestId: randomUUID(), body: "A private note" };
  assert.equal((await s.request("/" + id + "/notes", { method: "POST", body: message })).status, 404);
  assert.equal((await s.request("/" + id + "/activity")).status, 404);
  assert.equal((await s.request("/" + id, { method: "PATCH", body: { status: "resolved" } })).status, 404);
  assert.equal((await s.request("/" + id + "/notes", { scope: "admin", method: "POST", body: message })).status, 201);
  assert.equal(s.state.calls.at(-1).internal, true);
  assert.equal((await s.request("/" + id + "/replies", { scope: "admin", method: "POST", body: { ...message, requestId: randomUUID(), status: "resolved" } })).status, 201);
  assert.equal(s.state.calls.at(-1).internal, false);
  assert.equal(s.state.calls.at(-1).data.status, "resolved");
});
test("support validates fields, cursors and request formats before storage", async t => {
  const s = await fixture(t);
  for (const body of [{ ...report(), attachments: [] }, { ...report(), description: "short" }, { ...report(), category: "arbitrary" }, { ...report(), requestId: "sql' OR true" }]) assert.equal((await s.request("", { method: "POST", body })).status, 400);
  assert.equal((await s.request("?limit=1000")).status, 400);
  assert.equal((await s.request("?status[]=open")).status, 400);
  assert.equal((await s.request("", { method: "POST", raw: "{broken" })).status, 400);
  assert.equal((await s.request("", { method: "POST", raw: "plain text", contentType: "text/plain" })).status, 415);
  assert.equal((await s.request("", { method: "POST", raw: JSON.stringify({ ...report(), description: "x".repeat(34000) }) })).status, 413);
  assert.equal(s.state.calls.length, 0);
});
test("support errors and authentication failures are no-store and redact provider/SQL details", async t => {
  const s = await fixture(t);
  const { data } = await s.request("", { method: "POST", body: report() });
  s.state.storeError = new Error("postgres://secret:password@private-host/raw sql");
  const result = await s.request("/" + data.ticket.id);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify([result.data, s.state.logs]), /secret|password|private-host|raw sql/);
  s.state.storeError = { code: "42P01" };
  assert.equal((await s.request("/" + data.ticket.id)).data.code, "SUPPORT_NOT_INITIALIZED");
  assert.equal((await s.request("", { scope: "admin", auth: null })).headers.get("cache-control"), "no-store");
});
test("support authentication deadlines abort provider reads without leaking credentials", async t => {
  const s = await fixture(t);
  s.state.holdAuth = true;
  const result = await s.request();
  assert.equal(result.status, 503);
  assert.equal(s.state.aborted, true);
  assert.equal(s.state.calls.length, 0);
});
test("support applies actor-level throttling with a Retry-After response", async t => {
  const s = await fixture(t);
  for (let i = 0; i < 12; i++) assert.equal((await s.request("", { method: "POST", body: report() })).status, 201);
  const limited = await s.request("", { method: "POST", body: report() });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  s.state.clock += 60001;
  assert.equal((await s.request("", { method: "POST", body: report() })).status, 201);
});
test("support status changes, search, and audit queries are admin-only and bounded", async t => {
  const s = await fixture(t);
  const { data } = await s.request("", { method: "POST", body: report() });
  const id = data.ticket.id;
  assert.equal((await s.request("/" + id, { scope: "admin", method: "PATCH", body: { requestId: randomUUID(), expectedVersion: 1, status: "in_review", assignment: "me" } })).status, 200);
  assert.equal((await s.request("/" + id, { scope: "admin", method: "PATCH", body: { requestId: randomUUID(), status: "resolved" } })).status, 400);
  assert.equal((await s.request("?q=stuck&playerId=" + OWNER, { scope: "admin" })).status, 200);
  assert.equal((await s.request("/" + id + "/activity?limit=2", { scope: "admin" })).status, 200);
});
test("support is mounted before the shared parser without changing existing API mounts", () => {
  const source = readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.ok(source.indexOf('app.use("/api/player/support"') < source.indexOf("app.use(express.json())"));
  assert.ok(source.indexOf('app.use("/api/admin/support"') < source.indexOf('app.use("/api/admin", adminRoutes)'));
  for (const mounted of ['"/api/auth", authRoutes', '"/api/player/companies", playerCompaniesRouter()', '"/api", playerLedgerRouter()']) assert.ok(source.includes(mounted));
});
