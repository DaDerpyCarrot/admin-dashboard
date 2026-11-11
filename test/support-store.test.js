"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const d = require("../services/support-domain");
const { createSupportStore } = require("../services/support-store");
let PGlite;
try { ({ PGlite } = require("@electric-sql/pglite")); } catch (_) { /* Optional local-only SQL test engine. */ }
const sqlTest = (name, work) => test(name, { skip: !PGlite && "Optional PGlite test engine is not installed; no remote database is used." }, work);
let db, store;
let tail = Promise.resolve();
async function acquire() { let release; const previous = tail; tail = new Promise(resolve => { release = resolve; }); await previous; return release; }
const pool = {
  async connect() { const release = await acquire(); return { query: (sql, values) => db.query(sql, values), release }; },
  async query(sql, values) { const release = await acquire(); try { return await db.query(sql, values); } finally { release(); } }
};
const player = id => ({ title: "1E22BA", actor: { role: "player", id, name: "Operator " + id } });
const admin = { title: "1E22BA", actor: { role: "admin", id: "testadmin", name: "Test Admin" } };
const report = (extra = {}) => d.creation({ requestId: randomUUID(), category: "bug", area: "game", subject: "A repair gets stuck", description: "The repair does not finish after completing the listed tasks.", ...extra });
const reply = (body = "Checking the road.", status) => d.reply({ requestId: randomUUID(), body, ...(status ? { status } : {}) }, Boolean(status));
before(async () => { if (PGlite) { db = new PGlite(); await db.exec(readFileSync(path.join(__dirname, "../db/support-schema.sql"), "utf8")); store = createSupportStore(pool); } });
beforeEach(async () => { if (db) await db.exec("TRUNCATE road_support_activity,road_support_entries,road_support_tickets RESTART IDENTITY CASCADE"); });
after(async () => { if (db) await db.close(); });

sqlTest("support SQL schema is additive and can be applied twice", async () => {
  const sql = readFileSync(path.join(__dirname, "../db/support-schema.sql"), "utf8");
  await db.exec(sql);
  assert.doesNotMatch(sql, /DROP|TRUNCATE|road_purchase|road_companies/i);
});
sqlTest("support creates atomically and repeat sends return the same report", async () => {
  const data = report();
  const first = await store.create(player("ABCD"), data);
  const repeated = await store.create(player("ABCD"), data);
  assert.equal(first.ticket.reference, "RD-000001");
  assert.equal(repeated.ticket.id, first.ticket.id);
  assert.equal(repeated.replayed, true);
  await assert.rejects(store.create(player("ABCD"), { ...data, subject: "Different content" }), { status: 409 });
  const count = await db.query("SELECT count(*)::int AS n FROM road_support_activity");
  assert.equal(count.rows[0].n, 1);
});
sqlTest("support enforces report ownership and title boundaries for details and replies", async () => {
  const { ticket } = await store.create(player("ABCD"), report());
  for (const ctx of [player("BCDE"), { ...player("ABCD"), title: "FFFF" }]) {
    await assert.rejects(store.get(ctx, ticket.id), { status: 404 });
    await assert.rejects(store.messages(ctx, ticket.id, { after: null, limit: 30 }), { status: 404 });
    await assert.rejects(store.append(ctx, ticket.id, reply()), { status: 404 });
    assert.equal((await store.list(ctx, { limit: 30 })).tickets.length, 0);
  }
});
sqlTest("internal notes do not leak through player conversations, metadata, or pagination", async () => {
  const p = player("ABCD");
  const { ticket } = await store.create(p, report());
  await store.append(admin, ticket.id, d.reply({ requestId: randomUUID(), body: "Private investigation details." }, true, true), true);
  const afterNote = await store.get(p, ticket.id);
  assert.equal(String(afterNote.updatedAt), String(ticket.updatedAt));
  const a = reply("Please try once more.", "needs_reply");
  await store.append(admin, ticket.id, a);
  await store.append(admin, ticket.id, d.reply({ requestId: randomUUID(), body: "Another private note." }, true, true), true);
  await store.append(p, ticket.id, reply("I can still reproduce it."));
  const first = await store.messages(p, ticket.id, { after: null, limit: 1 });
  const second = await store.messages(p, ticket.id, { after: first.nextCursor, limit: 1 });
  assert.equal(first.messages[0].body, "Please try once more.");
  assert.equal(first.messages[0].authorName, "LNJK Support");
  assert.equal(second.messages[0].body, "I can still reproduce it.");
  assert.equal(second.nextCursor, null);
  assert.doesNotMatch(JSON.stringify([first, second, afterNote]), /Private investigation|Another private|Test Admin|testadmin|assignedTo|authorId/);
  assert.equal((await store.messages(admin, ticket.id, { after: null, limit: 30 })).messages.length, 4);
});
sqlTest("support replies and administrative changes are idempotent and audited", async () => {
  const { ticket } = await store.create(player("ABCD"), report());
  const data = reply("An administrator answer.", "resolved");
  const first = await store.append(admin, ticket.id, data);
  const repeat = await store.append(admin, ticket.id, data);
  assert.equal(first.message.id, repeat.message.id);
  assert.equal(repeat.replayed, true);
  const change = d.patch({ requestId: randomUUID(), expectedVersion: first.ticket.version, assignment: "me" });
  const changed = await store.update(admin, ticket.id, change);
  assert.equal(changed.ticket.assignedTo, "testadmin");
  assert.equal((await store.update(admin, ticket.id, change)).replayed, true);
  await assert.rejects(store.update(admin, ticket.id, { ...change, requestId: randomUUID(), status: "open" }), { code: "SUPPORT_CHANGED" });
  assert.equal((await store.activity(admin, ticket.id, { limit: 30 })).activity.length, 3);
});
sqlTest("player follow-ups reopen resolved reports without granting moderation privileges", async () => {
  const p = player("ABCD");
  const { ticket } = await store.create(p, report());
  await store.append(admin, ticket.id, reply("This is resolved.", "resolved"));
  assert.equal((await store.append(p, ticket.id, reply("The issue returned."))).ticket.status, "open");
  await assert.rejects(store.update(p, ticket.id, d.patch({ requestId: randomUUID(), expectedVersion: 3, status: "resolved" })), { status: 404 });
  await assert.rejects(store.activity(p, ticket.id, { limit: 30 }), { status: 404 });
});
sqlTest("durable creation quotas allow replays but reject a fourth new report", async () => {
  const p = player("ABCD"), first = report();
  await Promise.all([store.create(p, first), store.create(p, report()), store.create(p, report())]);
  assert.equal((await store.create(p, first)).replayed, true);
  await assert.rejects(store.create(p, report()), { status: 429 });
  assert.equal((await store.create(player("BCDE"), report())).replayed, false);
});
sqlTest("list filters paginate newest first and treat wildcard search characters literally", async () => {
  const p = player("ABCD");
  const one = await store.create(p, report({ subject: "100% complete but stuck" }));
  await store.create(p, report({ subject: "Other work", category: "suggestion" }));
  const first = await store.list(p, { limit: 1 });
  const second = await store.list(p, { limit: 1, before: first.nextCursor });
  assert.equal(second.tickets[0].id, one.ticket.id);
  assert.equal(second.nextCursor, null);
  assert.equal((await store.list(admin, { limit: 30, q: "%" })).tickets.length, 1);
  assert.equal((await store.list(admin, { limit: 30, q: "RD-000001" })).tickets[0].id, one.ticket.id);
  assert.equal((await store.summary(admin)).needsAttention, 2);
});
sqlTest("SQL failures roll back the report as well as its audit event", async () => {
  const failing = createSupportStore({
    async connect() {
      const dbClient = await pool.connect();
      return { query: (sql, values) => /INSERT INTO road_support_activity/.test(sql) ? Promise.reject(new Error("injected failure")) : dbClient.query(sql, values), release: dbClient.release };
    }
  });
  await assert.rejects(failing.create(player("ABCD"), report()), /injected/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM road_support_tickets")).rows[0].n, 0);
});
