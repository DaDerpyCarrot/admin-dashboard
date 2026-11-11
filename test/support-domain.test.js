"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../services/support-domain");
const requestId = "11111111-1111-4111-8111-111111111111";
const basic = () => ({ requestId, category: "bug", area: "game", subject: "A repair gets stuck", description: "The repair does not finish when all tasks are done." });
test("support validates and normalizes text without trusting client identity", () => {
  const value = d.creation({ ...basic(), description: "  Line one\r\nLine two. 🦫  " });
  assert.equal(value.description, "Line one\nLine two. 🦫");
  assert.equal(value.gameVersion, "");
  assert.equal(d.creation({ ...basic(), description: "<script>plain text, never rendered as HTML</script>" }).description.startsWith("<script>"), true);
  for (const extra of [{ playerId: "B123" }, { titleId: "AAAA" }, { status: "resolved" }, { role: "admin" }, { attachments: [] }, { browserToken: "private" }]) assert.throws(() => d.creation({ ...basic(), ...extra }), { status: 400 });
});
test("support bounds long, malformed and control-character text", () => {
  for (const description of ["short", "x".repeat(5001), "bad\u0000content", "bad\ud800content", "bad\u202Econtent"]) assert.throws(() => d.creation({ ...basic(), description }), { status: 400 });
  assert.throws(() => d.creation({ ...basic(), subject: "bad\nsubject" }), { status: 400 });
  for (const category of [null, "purchase", [], { bug: true }]) assert.throws(() => d.creation({ ...basic(), category }), { status: 400 });
  assert.equal(d.reply({ requestId, body: "🦫".repeat(5000) }).body.length, 10000);
});
test("players cannot inject reply visibility, status or admin assignment", () => {
  for (const fields of [{ visibility: "internal" }, { authorId: "admin" }, { status: "resolved" }]) assert.throws(() => d.reply({ requestId, body: "Hello", ...fields }), { status: 400 });
  assert.equal(d.reply({ requestId, body: "Please clarify." }, true).status, "needs_reply");
  assert.throws(() => d.reply({ requestId, body: "Private note", status: "resolved" }, true, true), { status: 400 });
});
test("admin changes require version checks and self-assignment only", () => {
  assert.equal(d.patch({ requestId, expectedVersion: 2, assignment: "me" }).assignment, "me");
  for (const bad of [{ requestId, status: "resolved" }, { requestId, expectedVersion: 1 }, { requestId, expectedVersion: 1, assignment: "someone-else" }, { requestId, expectedVersion: 1, status: "resolved", playerId: "ABCD" }]) assert.throws(() => d.patch(bad), { status: 400 });
});
test("pagination filters are bounded and cannot select another player", () => {
  assert.equal(d.listQuery({ limit: "5", before: "40", category: "bug" }).limit, 5);
  for (const query of [{ playerId: "ABCD" }, { limit: "31" }, { before: "0" }, { limit: ["2", "3"] }, { q: "hidden" }]) assert.throws(() => d.listQuery(query), { status: 400 });
  assert.equal(d.listQuery({ playerId: "abcd", q: "100% road" }, true).playerId, "ABCD");
  assert.throws(() => d.threadQuery({ visibility: "all" }), { status: 400 });
});
test("duplicate sends compare normalized immutable content", () => {
  const first = d.creation(basic());
  const second = d.creation({ ...basic(), requestId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(d.fingerprint("create", first), d.fingerprint("create", second));
  assert.throws(() => d.sameRequest({ payload_hash: "wrong" }, d.fingerprint("create", first)), { status: 409 });
});
test("player projections omit internal metadata, notes and admin identities", () => {
  const row = { id: requestId, ticket_no: "1234567", assigned_admin: "private-admin", player_id: "ABCD", player_name: "Operator", version: 9,
    created_at: "first", public_updated_at: "public-time", updated_at: "private-note-time", description: "description" };
  const projected = d.projectTicket(row, false, true);
  assert.equal(projected.reference, "RD-1234567");
  assert.equal(projected.updatedAt, "public-time");
  for (const key of ["version", "assignedTo", "player"]) assert.equal(Object.hasOwn(projected, key), false);
  assert.throws(() => d.projectEntry({ visibility: "internal" }, false));
  assert.equal(d.projectEntry({ visibility: "public", author_role: "admin", author_name: "private-admin" }).authorName, "LNJK Support");
  assert.equal(d.displayName({ PrivateInfo: { Email: "private@example.invalid" } }), "Operator");
});
