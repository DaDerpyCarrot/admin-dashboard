"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminFriendsReader, sanitizeAdminInternalData, validPlayerId } = require("../services/adminFriends");

const peer = (id, extra = {}) => ({ id, displayName: `Builder ${id}`, online: false, ...extra });
const hubResponse = hub => ({ data: { FunctionResult: hub } });
const empty = () => ({ friends: [], incoming: [], outgoing: [] });
const noAvatar = async () => ({ data: { Data: {} } });

test("runs only GetWorkerFriendHub as the SELECTED player, never the admin", async () => {
  const calls = [];
  const read = createAdminFriendsReader({
    callPlayFab: async (...args) => { calls.push(args); return hubResponse(empty()); },
    getUserData: noAvatar,
    now: () => new Date("2026-10-07T12:00:00Z")
  });
  const result = await read("SELECTED123");
  assert.deepEqual(calls, [["/Server/ExecuteCloudScript", {
    PlayFabId: "SELECTED123", FunctionName: "GetWorkerFriendHub", FunctionParameter: {},
    RevisionSelection: "Live", GeneratePlayStreamEvent: false
  }]]);
  assert.equal(result.playFabId, "SELECTED123");
  assert.deepEqual(result.counts, { friends: 0, incoming: 0, outgoing: 0 });
  assert.equal(result.fetchedAt, "2026-10-07T12:00:00.000Z");
});

test("normalizes duplicate/self/invalid rows and confirmed friendship wins over pending mirrors", async () => {
  const read = createAdminFriendsReader({
    callPlayFab: async () => hubResponse({
      friends: [peer("FRIEND1"), peer("friend1"), peer("OWNER1"), peer("<script>"), null],
      incoming: [peer("FRIEND1"), peer("RECEIVED1"), peer("RECEIVED1")],
      outgoing: [peer("FRIEND1"), peer("SENT1", { online: "true", displayName: "" })]
    }), getUserData: noAvatar
  });
  const result = await read("OWNER1");
  assert.deepEqual(result.counts, { friends: 1, incoming: 1, outgoing: 1 });
  assert.equal(result.outgoing[0].displayName, "Builder");
  assert.equal(result.outgoing[0].online, null);
});

test("returns only curated contact fields and reads only PUBLIC allowlisted avatars", async () => {
  const calls = [];
  const read = createAdminFriendsReader({
    callPlayFab: async () => hubResponse({ ...empty(), friends: [
      peer("PUBLIC1", { Email: "not-returned", internalData: { WorkerMessage_123: "secret" } }),
      peer("PRIVATE1"), peer("INVALID1"), peer("ERROR1")
    ] }),
    getUserData: async (id, keys) => {
      calls.push([id, keys]);
      if (id === "ERROR1") throw new Error("secret payload");
      return { data: { Data: { ProfileAvatar: {
        Permission: id === "PRIVATE1" ? "Private" : "Public",
        Value: id === "INVALID1" ? "../../danger" : "avatar_surveyor"
      }, Email: { Value: "private" } } } };
    }
  });
  const result = await read("OWNER1");
  assert.ok(calls.every(([, keys]) => JSON.stringify(keys) === '["ProfileAvatar"]'));
  assert.equal(result.friends[0].avatar, "avatar_surveyor");
  assert.ok(result.friends.slice(1).every(row => row.avatar === "avatar_roadbuilder"));
  assert.equal(result.avatarReadsUnavailable, 1);
  assert.deepEqual(Object.keys(result.friends[0]).sort(), ["avatar", "displayName", "online", "playFabId"]);
  assert.ok(!JSON.stringify(result).includes("not-returned"));
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("avatar reads use at most four concurrent calls", async () => {
  let active = 0, peak = 0;
  const read = createAdminFriendsReader({
    callPlayFab: async () => hubResponse({ ...empty(), friends: Array.from({ length: 12 }, (_, i) => peer(`FRIEND${i}`)) }),
    getUserData: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return { data: { Data: {} } };
    }
  });
  const result = await read("OWNER1");
  assert.equal(result.friends.length, 12);
  assert.equal(peak, 4);
});

test("accepts serialized FunctionResult", async () => {
  const read = createAdminFriendsReader({ callPlayFab: async () => hubResponse(JSON.stringify(empty())), getUserData: noAvatar });
  assert.equal((await read("OWNER1")).counts.friends, 0);
});

test("hanging avatar reads return defaults without spawning more than four requests", async () => {
  let calls = 0;
  const read = createAdminFriendsReader({
    callPlayFab: async () => hubResponse({ ...empty(), friends: Array.from({ length: 12 }, (_, i) => peer(`FRIEND${i}`)) }),
    getUserData: () => { calls++; return new Promise(() => {}); }
  });
  const result = await read("OWNER1");
  assert.equal(calls, 4);
  assert.equal(result.avatarReadsUnavailable, 12);
  assert.equal(result.friends.length, 12);
  assert.ok(result.friends.every(row => row.avatar === "avatar_roadbuilder"));
});

for (const [label, response] of [
  ["script error", { data: { Error: { Message: "private error" } } }],
  ["oversized result", { data: { FunctionResultTooLarge: true } }],
  ["missing script result", { data: {} }],
  ["malformed groups", hubResponse({ friends: [] })],
  ["invalid JSON result", hubResponse("not JSON")]
]) {
  test(`${label} is an error, not a fake empty crew`, async () => {
    const read = createAdminFriendsReader({ callPlayFab: async () => response, getUserData: noAvatar });
    await assert.rejects(read("OWNER1"), error => error.status === 502 && !error.message.includes("private error"));
  });
}

test("invalid player IDs never reach PlayFab", async () => {
  let called = false;
  const read = createAdminFriendsReader({ callPlayFab: async () => { called = true; }, getUserData: noAvatar });
  for (const id of ["", "ab", "../OWNER1", "<script>", "a".repeat(65), null]) {
    assert.equal(validPlayerId(id), false);
    await assert.rejects(read(id), error => error.status === 400);
  }
  assert.equal(called, false);
});

test("upstream failures are sanitized", async () => {
  const read = createAdminFriendsReader({ callPlayFab: async () => { throw new Error("X-SecretKey sensitive"); }, getUserData: noAvatar });
  await assert.rejects(read("OWNER1"), error => error.status === 502 && !error.message.includes("sensitive"));
});

test("raw Admin Data excludes messages/presence/social mirrors and preserves moderation", () => {
  const input = {
    AdminNote: { Value: "keep" }, AccountStatus: { Value: "flagged" }, ModerationHistory: { Value: "[]" },
    WorkerMessage_OWNER1: { Value: "private chat" }, WorkerFriend_OWNER1: { Value: "1" },
    WorkerFriendIn_OWNER1: { Value: "pending" }, WorkerFriendOut_OWNER1: { Value: "pending" },
    WorkerPresence: { Value: "12345" }, OtherGameData: { Value: "keep" }
  };
  assert.deepEqual(Object.keys(sanitizeAdminInternalData(input)), ["AdminNote", "AccountStatus", "ModerationHistory", "OtherGameData"]);
  assert.ok(input.WorkerMessage_OWNER1); // no mutation of stored records
});
