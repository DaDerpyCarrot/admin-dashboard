"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { name, playerId, uuid, body, pageCursor, publicName, projectProfile } = require("../services/company-domain");

test("company labels accept normal Unicode and reject invalid fields", () => {
  assert.equal(name("  Pave Paws & Co. 🦫  "), "Pave Paws & Co. 🦫");
  assert.equal(name("Caf\u0065\u0301 Roadworks"), "Café Roadworks");
  for (const bad of ["", "ab", "a".repeat(61), "bad\nname", "bad\u202Ename", "<Company>", "\ud800abc", 1]) {
    assert.throws(() => name(bad), { status: 400 });
  }
  assert.throws(() => body({ name: "Builders", moderatorId: "F00D" }, ["name"]), { status: 400 });
  assert.throws(() => body([], ["name"]), { status: 400 });
});

test("identifiers and list cursors are normalized and constrained", () => {
  const id = "51234567-1234-4123-A123-0123456789AB";
  assert.equal(uuid(id), id.toLowerCase());
  assert.equal(playerId("a0bc"), "A0BC");
  assert.equal(pageCursor({}), null);
  assert.equal(pageCursor({ after: id }), id.toLowerCase());
  for (const invalid of ["x' OR true", " AB123 ", "", "Z0ABC", {}]) assert.throws(() => playerId(invalid), { status: 400 });
  assert.throws(() => pageCursor({ after: [id, id] }), { status: 400 });
  assert.throws(() => pageCursor({ playerId: "AB123" }), { status: 400 });
});

test("player labels never fall back to account email", () => {
  assert.equal(publicName({ TitleInfo: { DisplayName: "Pave Paws" }, PrivateInfo: { Email: "private@example.invalid" } }), "Pave Paws");
  assert.equal(publicName({ TitleInfo: { DisplayName: "private@example.invalid" }, Username: "RoadBuilder" }), "RoadBuilder");
  assert.equal(publicName({ PrivateInfo: { Email: "private@example.invalid" } }), "Builder");
});

test("public profile output is allowlisted and missing/invalid values are not zero", () => {
  const record = (Value, Permission = "Public") => ({ Value, Permission });
  assert.deepEqual(projectProfile({
    ProfileAvatar: record("avatar_pavepaws"),
    ProfileAboutMe: record("private bio", "Private"),
    ProfileTotalXP: record("240"),
    ProfileJobsCompleted: record("0"),
    ProfileJobsAttempted: { Value: "5" },
    unrelated: record("should never appear")
  }), { avatar: "avatar_pavepaws", bio: "", xp: 240, completed: 0, attempted: null });
  assert.deepEqual(projectProfile({
    ProfileAvatar: record("https://example.invalid/not-an-avatar"),
    ProfileAboutMe: record("x".repeat(1100)),
    ProfileTotalXP: record("2147483648"),
    ProfileJobsCompleted: record("-1"),
    ProfileJobsAttempted: record("3.5")
  }), { avatar: "avatar_roadbuilder", bio: "x".repeat(1000), xp: null, completed: null, attempted: null });
});
