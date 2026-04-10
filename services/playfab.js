const dotenv = require("dotenv");

dotenv.config();

const PLAYFAB_TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const PLAYFAB_SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;

if (!PLAYFAB_TITLE_ID || !PLAYFAB_SECRET_KEY) {
  console.warn("Missing PlayFab environment variables.");
}

async function callPlayFab(endpoint, body = {}) {
  const url = `https://${PLAYFAB_TITLE_ID}.playfabapi.com${endpoint}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SecretKey": PLAYFAB_SECRET_KEY
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.errorMessage || "PlayFab request failed.");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

/* ================= BASIC READS ================= */

async function getUserData(playFabId, keys = null) {
  const body = { PlayFabId: playFabId };

  if (Array.isArray(keys) && keys.length > 0) {
    body.Keys = keys;
  }

  return callPlayFab("/Server/GetUserData", body);
}

async function getUserInternalData(playFabId, keys = null) {
  const body = { PlayFabId: playFabId };

  if (Array.isArray(keys) && keys.length > 0) {
    body.Keys = keys;
  }

  return callPlayFab("/Admin/GetUserInternalData", body);
}

async function getPlayerProfile(playFabId) {
  return callPlayFab("/Server/GetPlayerProfile", {
    PlayFabId: playFabId,
    ProfileConstraints: {
      ShowDisplayName: true,
      ShowCreated: true,
      ShowLastLogin: true,
      ShowContactEmailAddresses: true,
      ShowBannedUntil: true
    }
  });
}

async function getPlayerStatistics(playFabId) {
  return callPlayFab("/Server/GetPlayerStatistics", {
    PlayFabId: playFabId
  });
}

async function getPlayerSegments(playFabId) {
  return callPlayFab("/Server/GetPlayerSegments", {
    PlayFabId: playFabId
  });
}

/* ================= PASSWORD RESET ================= */

async function resetPlayFabPassword(token, password) {
  return callPlayFab("/Admin/ResetPassword", {
    Token: token,
    Password: password
  });
}

/* ================= WRITES ================= */

async function updateUserInternalData(playFabId, dataObject, keysToRemove = []) {
  return callPlayFab("/Admin/UpdateUserInternalData", {
    PlayFabId: playFabId,
    Data: dataObject,
    KeysToRemove: keysToRemove
  });
}

async function banUser(playFabId, reason = "Admin action from dashboard", durationHours = 24) {
  const expiration = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();

  return callPlayFab("/Server/BanUsers", {
    Bans: [
      {
        PlayFabId: playFabId,
        Reason: reason,
        Expires: expiration
      }
    ]
  });
}

/* ================= SEGMENT EXPORT SUPPORT ================= */

async function getAllSegments() {
  return callPlayFab("/Server/GetAllSegments", {});
}

async function exportPlayersInSegment(segmentId) {
  return callPlayFab("/Admin/ExportPlayersInSegment", {
    SegmentId: segmentId
  });
}

async function getSegmentExport(exportId) {
  return callPlayFab("/Admin/GetSegmentExport", {
    ExportId: exportId
  });
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSegmentExport(exportId, maxAttempts = 20, delayMs = 1500) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await getSegmentExport(exportId);
    const exportInfo = result?.data || {};

    if (exportInfo.State === "Complete" && exportInfo.IndexUrl) {
      return exportInfo;
    }

    if (exportInfo.State === "Failed") {
      const error = new Error("Segment export failed.");
      error.details = exportInfo;
      throw error;
    }

    await delay(delayMs);
  }

  throw new Error("Timed out waiting for segment export.");
}

async function downloadExportIndex(indexUrl) {
  const response = await fetch(indexUrl);

  if (!response.ok) {
    throw new Error("Failed to download export index.");
  }

  const text = await response.text();

  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

async function downloadExportFragments(fragmentUrls) {
  const players = [];
  let loggedHeader = false;
  let loggedFirstRow = false;

  for (const url of fragmentUrls) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Failed to download export fragment.");
    }

    const text = await response.text();

    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      continue;
    }

    const headers = lines[0].split("\t").map(h => h.trim());

    if (!loggedHeader) {
      console.log("Segment export TSV headers:", headers);
      loggedHeader = true;
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");

      const row = {};
      headers.forEach((header, index) => {
        row[header] = (cols[index] || "").trim();
      });

      if (!loggedFirstRow) {
        console.log("Sample export TSV row:", row);
        loggedFirstRow = true;
      }

      players.push(row);
    }
  }

  console.log("Total parsed players from export fragments:", players.length);
  return players;
}

async function exportSegmentPlayersById(segmentId) {
  const exportStart = await exportPlayersInSegment(segmentId);
  const exportId = exportStart?.data?.ExportId;

  if (!exportId) {
    throw new Error("PlayFab did not return an ExportId.");
  }

  const exportInfo = await waitForSegmentExport(exportId);
  const fragmentUrls = await downloadExportIndex(exportInfo.IndexUrl);
  const players = await downloadExportFragments(fragmentUrls);

  return players;
}

async function findSegmentIdByName(segmentName) {
  const result = await getAllSegments();
  const segments = result?.data?.Segments || [];

  const match = segments.find(segment => {
    return (segment.Name || "").toLowerCase() === segmentName.toLowerCase();
  });

  return match ? match.Id : null;
}

async function exportSegmentPlayersByName(segmentName) {
  const segmentId = await findSegmentIdByName(segmentName);

  if (!segmentId) {
    throw new Error(`Segment "${segmentName}" was not found.`);
  }

  const players = await exportSegmentPlayersById(segmentId);

  return {
    segmentId,
    players
  };
}

/* ================= AGGREGATED PLAYER VIEW ================= */

async function getFullPlayerAdminView(playFabId) {
  const [profileRes, statsRes, segmentsRes, userDataRes, internalDataRes] = await Promise.all([
    getPlayerProfile(playFabId),
    getPlayerStatistics(playFabId),
    getPlayerSegments(playFabId),
    getUserData(playFabId),
    getUserInternalData(playFabId)
  ]);

  return {
    playFabId,
    profile: profileRes?.data?.PlayerProfile || null,
    statistics: statsRes?.data?.Statistics || [],
    segments: segmentsRes?.data?.Segments || [],
    userData: userDataRes?.data?.Data || {},
    internalData: internalDataRes?.data?.Data || {}
  };
}

async function updateUserData(playFabId, dataObject = {}, keysToRemove = []) {
  return callPlayFab("/Server/UpdateUserData", {
    PlayFabId: playFabId,
    Data: dataObject,
    KeysToRemove: keysToRemove
  });
}

module.exports = {
  callPlayFab,
  getUserData,
  getUserInternalData,
  getPlayerProfile,
  getPlayerStatistics,
  getPlayerSegments,
  resetPlayFabPassword,
  updateUserData,
  updateUserInternalData,
  banUser,
  getAllSegments,
  exportPlayersInSegment,
  getSegmentExport,
  exportSegmentPlayersByName,
  getFullPlayerAdminView
};