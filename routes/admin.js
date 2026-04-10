const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const ADMINS_FILE = path.join(__dirname, "..", "data", "admins.json");

function loadAdmins() {
  try {
    const raw = fs.readFileSync(ADMINS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to load admins.json:", error);
    return [];
  }
}

const express = require("express");
const jwt = require("jsonwebtoken");
const verifyAdminToken = require("../middleware/verifyAdminToken");
const {
  getFullPlayerAdminView,
  getUserInternalData,
  updateUserData,
  updateUserInternalData,
  banUser,
  exportSegmentPlayersByName
} = require("../services/playfab");

const router = express.Router();

const SEGMENT_NAME = (process.env.PLAYFAB_PLAYER_SEGMENT_NAME || "All Players").trim();

/* ================= PLAYER CACHE ================= */

let playerCache = {
  lastUpdated: 0,
  players: [],
  isRefreshing: false
};

const CACHE_TTL_MS = 5 * 60 * 1000;

/* ================= SUMMARY CACHE ================= */

let summaryCache = {
  byPlayer: {}, // playFabId -> { reviewed: boolean, flagged: boolean }
  playersReviewed: 0,
  flaggedPlayers: 0,
  lastRecountAt: 0,
  isRecounting: false
};

function safeValue(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry.Value === "string") return entry.Value;
  return "";
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function mapExportedProfile(profile) {
  const playFabId = pickFirst(profile, [
    "PlayerId",
    "PlayFabId",
    "MasterPlayerAccountId",
    "EntityId",
    "TitlePlayerAccountId",
    "playerid",
    "playfabid"
  ]);

  const displayName = pickFirst(profile, [
    "DisplayName",
    "TitleInfo.DisplayName",
    "displayname"
  ]);

  const created = pickFirst(profile, [
    "Created",
    "CreatedAt",
    "created"
  ]);

  const lastLogin = pickFirst(profile, [
    "LastLogin",
    "LastLoginTime",
    "lastlogin"
  ]);

  const bannedUntil = pickFirst(profile, [
    "BannedUntil",
    "banneduntil"
  ]) || null;

  return {
    playFabId,
    displayName,
    created,
    lastLogin,
    bannedUntil,
    raw: profile
  };
}

async function refreshPlayerCache(force = false) {
  const now = Date.now();

  if (!force && playerCache.players.length > 0 && now - playerCache.lastUpdated < CACHE_TTL_MS) {
    return playerCache.players;
  }

  if (playerCache.isRefreshing) {
    return playerCache.players;
  }

  playerCache.isRefreshing = true;

  try {
    console.log("Refreshing player cache from segment:", SEGMENT_NAME);

    const result = await exportSegmentPlayersByName(SEGMENT_NAME);

    const mappedPlayers = (result.players || [])
      .map(mapExportedProfile)
      .filter(player => player.playFabId);

    console.log("Mapped players count:", mappedPlayers.length);

    if (mappedPlayers.length > 0) {
      console.log("First mapped player:", mappedPlayers[0]);
    }

    playerCache.players = mappedPlayers;
    playerCache.lastUpdated = Date.now();

    return playerCache.players;
  } finally {
    playerCache.isRefreshing = false;
  }
}

/* ================= SUMMARY HELPERS ================= */

function getAdminSummaryFromInternalData(internalData = {}) {
  const reviewState = safeValue(internalData.ReviewState).toLowerCase();
  const accountStatus = safeValue(internalData.AccountStatus).toLowerCase();

  return {
    reviewed: reviewState !== "",
    flagged: accountStatus === "flagged" || accountStatus === "banned",
    accountStatus: accountStatus || "unknown",
    reviewState: reviewState || "unknown"
  };
}

function setTrackedSummary(playFabId, nextSummary) {
  const prevSummary = summaryCache.byPlayer[playFabId] || {
    reviewed: false,
    flagged: false,
    accountStatus: "unknown",
    reviewState: "unknown"
  };

  if (prevSummary.reviewed && !nextSummary.reviewed) {
    summaryCache.playersReviewed = Math.max(0, summaryCache.playersReviewed - 1);
  } else if (!prevSummary.reviewed && nextSummary.reviewed) {
    summaryCache.playersReviewed += 1;
  }

  if (prevSummary.flagged && !nextSummary.flagged) {
    summaryCache.flaggedPlayers = Math.max(0, summaryCache.flaggedPlayers - 1);
  } else if (!prevSummary.flagged && nextSummary.flagged) {
    summaryCache.flaggedPlayers += 1;
  }

  summaryCache.byPlayer[playFabId] = {
    reviewed: !!nextSummary.reviewed,
    flagged: !!nextSummary.flagged,
    accountStatus: nextSummary.accountStatus || "unknown",
    reviewState: nextSummary.reviewState || "unknown"
  };
}

function buildInternalDataShapeForSummary(existingInternalData, payload) {
  const merged = {
    ReviewState: safeValue(existingInternalData.ReviewState),
    AccountStatus: safeValue(existingInternalData.AccountStatus)
  };

  if (typeof payload.reviewState === "string") {
    merged.ReviewState = payload.reviewState;
  }

  if (typeof payload.accountStatus === "string") {
    merged.AccountStatus = payload.accountStatus;
  }

  return {
    ReviewState: { Value: merged.ReviewState },
    AccountStatus: { Value: merged.AccountStatus }
  };
}

const MODERATION_HISTORY_KEY = "ModerationHistory";
const MAX_HISTORY_ENTRIES = 50;

function parseModerationHistoryValue(rawValue) {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("Failed to parse moderation history JSON.");
    return [];
  }
}

function getModerationHistoryFromInternalData(internalData = {}) {
  const raw = safeValue(internalData[MODERATION_HISTORY_KEY]);
  return parseModerationHistoryValue(raw);
}

async function appendModerationHistoryEntry(playFabId, entry) {
  const currentResult = await getUserInternalData(playFabId);
  const currentInternalData = currentResult?.data?.Data || {};

  const currentHistory = getModerationHistoryFromInternalData(currentInternalData);

  const nextEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  };

  const nextHistory = [nextEntry, ...currentHistory].slice(0, MAX_HISTORY_ENTRIES);

  await updateUserInternalData(playFabId, {
    [MODERATION_HISTORY_KEY]: JSON.stringify(nextHistory)
  });

  return nextHistory;
}

async function recountAdminFlags() {
  if (summaryCache.isRecounting) {
    return {
      totalPlayersScanned: 0,
      playersReviewed: summaryCache.playersReviewed,
      flaggedPlayers: summaryCache.flaggedPlayers,
      alreadyRunning: true
    };
  }

  summaryCache.isRecounting = true;

  try {
    const players = await refreshPlayerCache(false);

    const nextByPlayer = {};
    let reviewedCount = 0;
    let flaggedCount = 0;

    const concurrency = 10;     // adjust as player database grows


    for (let i = 0; i < players.length; i += concurrency) {
      const chunk = players.slice(i, i + concurrency);

      const results = await Promise.all(
        chunk.map(async (player) => {
          try {
            const result = await getUserInternalData(player.playFabId);
            const internalData = result?.data?.Data || {};
            const summary = getAdminSummaryFromInternalData(internalData);

            return {
              playFabId: player.playFabId,
              summary
            };
          } catch (error) {
            console.warn(`Failed to recount internal data for ${player.playFabId}`);
            return {
              playFabId: player.playFabId,
              summary: { reviewed: false, flagged: false }
            };
          }
        })
      );

      for (const item of results) {
        nextByPlayer[item.playFabId] = item.summary;

        if (item.summary.reviewed) {
          reviewedCount += 1;
        }

        if (item.summary.flagged) {
          flaggedCount += 1;
        }
      }
    }

    summaryCache.byPlayer = nextByPlayer;
    summaryCache.playersReviewed = reviewedCount;
    summaryCache.flaggedPlayers = flaggedCount;
    summaryCache.lastRecountAt = Date.now();

    return {
      totalPlayersScanned: players.length,
      playersReviewed: reviewedCount,
      flaggedPlayers: flaggedCount,
      alreadyRunning: false
    };
  } finally {
    summaryCache.isRecounting = false;
  }
}

/* ================= LOGIN ================= */

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      message: "Username and password are required."
    });
  }

  const admins = loadAdmins();

  const adminUser = admins.find(admin =>
    admin.username.toLowerCase() === String(username).trim().toLowerCase()
  );

  if (!adminUser || !adminUser.isActive) {
    return res.status(401).json({
      ok: false,
      message: "Invalid admin credentials."
    });
  }

  const passwordMatches = await bcrypt.compare(password, adminUser.passwordHash);

  if (!passwordMatches) {
    return res.status(401).json({
      ok: false,
      message: "Invalid admin credentials."
    });
  }

  const token = jwt.sign(
    {
      username: adminUser.username,
      role: adminUser.role
    },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({
    ok: true,
    message: "Login successful.",
    token,
    admin: {
      username: adminUser.username,
      role: adminUser.role
    }
  });
});

/* ================= PROTECTED ROUTES ================= */

router.get("/me", verifyAdminToken, (req, res) => {
  res.json({
    ok: true,
    admin: req.admin
  });
});

router.post("/refresh-player-cache", verifyAdminToken, async (req, res, next) => {
  try {
    const players = await refreshPlayerCache(true);

    res.json({
      ok: true,
      message: "Player cache refreshed.",
      totalPlayers: players.length
    });
  } catch (error) {
    next(error);
  }
});

router.post("/recount-admin-flags", verifyAdminToken, async (req, res, next) => {
  try {
    const recount = await recountAdminFlags();

    res.json({
      ok: true,
      message: recount.alreadyRunning
        ? "Recount is already running."
        : "Admin flags recounted.",
      ...recount
    });
  } catch (error) {
    next(error);
  }
});

router.get("/overview", verifyAdminToken, async (req, res, next) => {
  try {
    await refreshPlayerCache(false);

    res.json({
      ok: true,
      stats: {
        totalPlayers: playerCache.players.length,
        playersReviewed: summaryCache.playersReviewed,
        flaggedPlayers: summaryCache.flaggedPlayers,
        serverStatus: "Online"
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/player-search", verifyAdminToken, async (req, res, next) => {
  try {
    const query = (req.query.q || "").trim().toLowerCase();

    if (!query) {
      return res.json({
        ok: true,
        players: []
      });
    }

    const players = await refreshPlayerCache(false);

    const filtered = players.filter(player => {
      return (
        (player.playFabId || "").toLowerCase().includes(query) ||
        (player.displayName || "").toLowerCase().includes(query)
      );
    });

    res.json({
      ok: true,
      players: filtered.slice(0, 25)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/player/:playFabId", verifyAdminToken, async (req, res, next) => {
  try {
    const { playFabId } = req.params;
    const player = await getFullPlayerAdminView(playFabId);

    const summary = getAdminSummaryFromInternalData(player.internalData || {});
    setTrackedSummary(playFabId, summary);

    const moderationHistory = getModerationHistoryFromInternalData(player.internalData || {});

    res.json({
      ok: true,
      player: {
        ...player,
        moderationHistory
      }
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/player/:playFabId/internal", verifyAdminToken, async (req, res, next) => {
  try {
    const { playFabId } = req.params;
    const {
      adminNote,
      accountStatus,
      reviewState,
      strikeCount
    } = req.body;

    const dataToUpdate = {};

    if (typeof adminNote === "string") dataToUpdate.AdminNote = adminNote;
    if (typeof accountStatus === "string") dataToUpdate.AccountStatus = accountStatus;
    if (typeof reviewState === "string") dataToUpdate.ReviewState = reviewState;
    if (typeof strikeCount === "number") dataToUpdate.StrikeCount = String(strikeCount);

    if (Object.keys(dataToUpdate).length === 0) {
      return res.status(400).json({
        ok: false,
        message: "Nothing to update."
      });
    }

    const beforeResult = await getUserInternalData(playFabId);
    const beforeInternalData = beforeResult?.data?.Data || {};

    const result = await updateUserInternalData(playFabId, dataToUpdate);

    await updateUserData(playFabId, {}, [
      "AdminNote",
      "AccountStatus",
      "ReviewState",
      "StrikeCount",
      "ModerationHistory"
    ]);

    const mergedInternalData = buildInternalDataShapeForSummary(beforeInternalData, {
      accountStatus,
      reviewState
    });

    const nextSummary = getAdminSummaryFromInternalData(mergedInternalData);
    setTrackedSummary(playFabId, nextSummary);

    const historyEntry = {
      action: "internal_update",
      admin: req.admin?.username || "unknown_admin",
      note: typeof adminNote === "string" ? adminNote : "",
      accountStatus: typeof accountStatus === "string" ? accountStatus : safeValue(beforeInternalData.AccountStatus),
      reviewState: typeof reviewState === "string" ? reviewState : safeValue(beforeInternalData.ReviewState),
      strikeCount: typeof strikeCount === "number"
        ? strikeCount
        : Number(safeValue(beforeInternalData.StrikeCount) || 0)
    };

    const moderationHistory = await appendModerationHistoryEntry(playFabId, historyEntry);
    console.log("Updated moderation history:", moderationHistory);

    res.json({
      ok: true,
      message: "Internal admin data updated.",
      result: result.data || result,
      moderationHistory
    });
  } catch (error) {
    next(error);
  }
});

router.post("/player/:playFabId/ban", verifyAdminToken, async (req, res, next) => {
  try {
    const { playFabId } = req.params;
    const { reason, durationHours } = req.body;

    const safeDuration = Number(durationHours) || 24;
    const safeReason = reason || "Admin action from dashboard";

    const result = await banUser(
      playFabId,
      safeReason,
      safeDuration
    );

    await updateUserInternalData(playFabId, {
      AccountStatus: "banned"
    });

    setTrackedSummary(playFabId, {
      reviewed: summaryCache.byPlayer[playFabId]?.reviewed || false,
      flagged: true,
      accountStatus: "banned",
      reviewState: summaryCache.byPlayer[playFabId]?.reviewState || "unknown"
    });

    const moderationHistory = await appendModerationHistoryEntry(playFabId, {
      action: "banned",
      admin: req.admin?.username || "unknown_admin",
      note: safeReason,
      durationHours: safeDuration,
      accountStatus: "banned",
      reviewState: summaryCache.byPlayer[playFabId]?.reviewState || "unknown",
      strikeCount: Number(summaryCache.byPlayer[playFabId]?.strikeCount || 0)
    });

    res.json({
      ok: true,
      message: "Player banned.",
      result: result.data || result,
      moderationHistory
    });
  } catch (error) {
    next(error);
  }
});

router.get("/debug/player-cache", verifyAdminToken, async (req, res, next) => {
  try {
    const players = await refreshPlayerCache(false);

    res.json({
      ok: true,
      totalPlayers: players.length,
      firstFive: players.slice(0, 5),
      summaryCache
    });
  } catch (error) {
    next(error);
  }
});

router.get("/player-list", verifyAdminToken, async (req, res, next) => {
  try {
    const {
      q = "",
      accountStatus = "",
      reviewState = "",
      flaggedOnly = "false",
      reviewedOnly = "false",
      limit = "50"
    } = req.query;

    const players = await refreshPlayerCache(false);

    const normalizedQuery = String(q).trim().toLowerCase();
    const normalizedAccountStatus = String(accountStatus).trim().toLowerCase();
    const normalizedReviewState = String(reviewState).trim().toLowerCase();
    const flaggedFilter = String(flaggedOnly).toLowerCase() === "true";
    const reviewedFilter = String(reviewedOnly).toLowerCase() === "true";
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const rows = players.map(player => {
      const summary = summaryCache.byPlayer[player.playFabId] || {
        reviewed: false,
        flagged: false,
        accountStatus: "unknown",
        reviewState: "unknown"
      };

      return {
        playFabId: player.playFabId,
        displayName: player.displayName || "",
        created: player.created || "",
        lastLogin: player.lastLogin || "",
        bannedUntil: player.bannedUntil || null,
        reviewed: summary.reviewed,
        flagged: summary.flagged,
        accountStatus: summary.accountStatus || "unknown",
        reviewState: summary.reviewState || "unknown"
      };
    });

    const filtered = rows.filter(row => {
      const matchesQuery =
        !normalizedQuery ||
        row.playFabId.toLowerCase().includes(normalizedQuery) ||
        row.displayName.toLowerCase().includes(normalizedQuery);

      const matchesAccountStatus =
        !normalizedAccountStatus || row.accountStatus === normalizedAccountStatus;

      const matchesReviewState =
        !normalizedReviewState || row.reviewState === normalizedReviewState;

      const matchesFlagged =
        !flaggedFilter || row.flagged === true;

      const matchesReviewed =
        !reviewedFilter || row.reviewed === true;

      return (
        matchesQuery &&
        matchesAccountStatus &&
        matchesReviewState &&
        matchesFlagged &&
        matchesReviewed
      );
    });

    filtered.sort((a, b) => {
      const aTime = a.lastLogin ? new Date(a.lastLogin).getTime() : 0;
      const bTime = b.lastLogin ? new Date(b.lastLogin).getTime() : 0;
      return bTime - aTime;
    });

    res.json({
      ok: true,
      total: rows.length,
      filtered: filtered.length,
      players: filtered.slice(0, safeLimit)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;