"use strict";

// This reader calls ONLY the game's read-only friend hub, on behalf of the
// selected player. Never accept a CloudScript function name from HTTP input.
const AVATARS = new Set([
  "avatar_roadbuilder", "avatar_maplecrew", "avatar_asphaltace",
  "avatar_pavepaws", "avatar_brickbuddy", "avatar_surveyor",
  "avatar_forewoman", "avatar_uniform_white_khaki", "avatar_uniform_white_khaki_male"
]);
const PRIVATE_SOCIAL_KEY = /^(WorkerMessage_|WorkerFriend_|WorkerFriendIn_|WorkerFriendOut_|WorkerPresence$)/i;
const validPlayerId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{3,64}$/.test(value);

function sanitizeAdminInternalData(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !PRIVATE_SOCIAL_KEY.test(key)));
}

function publicError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  error.isAdminFriendsError = true;
  return error;
}

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Upstream timeout");
          error.code = "ADMIN_CREW_TIMEOUT";
          reject(error);
        }, milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createAdminFriendsReader({ callPlayFab, getUserData, now = () => new Date() }) {
  return async function readAdminFriends(playFabId) {
    if (!validPlayerId(playFabId)) {
      throw publicError("Select a valid title player PlayFab ID.", 400);
    }

    let execution;
    try {
      const response = await bounded(callPlayFab("/Server/ExecuteCloudScript", {
        PlayFabId: playFabId,
        FunctionName: "GetWorkerFriendHub",
        FunctionParameter: {},
        RevisionSelection: "Live",
        GeneratePlayStreamEvent: false
      }), 18000);
      execution = response?.data;
    } catch (_) {
      throw publicError("Could not read this player's crew from PlayFab. Please retry.");
    }

    if (!execution || execution.Error || execution.FunctionResultTooLarge) {
      throw publicError("The game's GetWorkerFriendHub could not complete. Check the live CloudScript revision, then retry.");
    }
    let hub = execution.FunctionResult;
    if (typeof hub === "string") {
      try { hub = JSON.parse(hub); } catch (_) { hub = null; }
    }
    if (!hub || !["friends", "incoming", "outgoing"].every(key => Array.isArray(hub[key]))) {
      throw publicError("The live GetWorkerFriendHub returned an unexpected format. No friend counts were inferred.");
    }

    const normalize = rows => {
      const seen = new Set();
      return rows.filter(row => {
        if (!row || !validPlayerId(row.id) || row.id.toLowerCase() === playFabId.toLowerCase()) return false;
        const key = row.id.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(row => ({
        playFabId: row.id,
        displayName: typeof row.displayName === "string" && row.displayName.trim()
          ? row.displayName.trim().slice(0, 128) : "Builder",
        online: typeof row.online === "boolean" ? row.online : null,
        avatar: "avatar_roadbuilder"
      }));
    };
    const friends = normalize(hub.friends);
    const friendIds = new Set(friends.map(row => row.playFabId.toLowerCase()));
    const incoming = normalize(hub.incoming).filter(row => !friendIds.has(row.playFabId.toLowerCase()));
    const outgoing = normalize(hub.outgoing).filter(row => !friendIds.has(row.playFabId.toLowerCase()));
    const contacts = [...friends, ...incoming, ...outgoing];
    const uniqueContacts = [...new Map(contacts.map(row => [row.playFabId.toLowerCase(), row])).values()];

    // Avatar reads are optional, public-only and bounded. The relationship list
    // still works if a deleted/private profile or a slow avatar read fails.
    const avatarById = new Map();
    const deadline = Date.now() + 6000;
    let cursor = 0;
    let avatarReadsUnavailable = 0;
    await Promise.all(Array.from({ length: Math.min(4, uniqueContacts.length) }, async () => {
      while (cursor < uniqueContacts.length) {
        const row = uniqueContacts[cursor++];
        const remaining = deadline - Date.now();
        if (remaining <= 0) { avatarReadsUnavailable++; continue; }
        try {
          const result = await bounded(getUserData(row.playFabId, ["ProfileAvatar"]), Math.min(3500, remaining));
          const entry = result?.data?.Data?.ProfileAvatar;
          if (entry?.Permission === "Public" && AVATARS.has(entry.Value)) {
            avatarById.set(row.playFabId.toLowerCase(), entry.Value);
          }
        } catch (error) {
          avatarReadsUnavailable++;
          // The existing PlayFab transport cannot abort a timed-out fetch. Stop
          // this worker instead of spawning more reads while that call hangs.
          if (error.code === "ADMIN_CREW_TIMEOUT") break;
        }
      }
    }));
    avatarReadsUnavailable += uniqueContacts.length - cursor;
    contacts.forEach(row => { row.avatar = avatarById.get(row.playFabId.toLowerCase()) || "avatar_roadbuilder"; });

    return {
      playFabId,
      friends,
      incoming,
      outgoing,
      counts: { friends: friends.length, incoming: incoming.length, outgoing: outgoing.length },
      fetchedAt: now().toISOString(),
      avatarReadsUnavailable
    };
  };
}

let defaultReader;
async function getAdminFriendHub(playFabId) {
  if (!defaultReader) {
    const { callPlayFab, getUserData } = require("./playfab");
    defaultReader = createAdminFriendsReader({ callPlayFab, getUserData });
  }
  return defaultReader(playFabId);
}

module.exports = { getAdminFriendHub, createAdminFriendsReader, sanitizeAdminInternalData, validPlayerId };
