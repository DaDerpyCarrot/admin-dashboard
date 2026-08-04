const fs = require("fs");
const path = require("path");

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

function normalizePlayFabId(value) {
  return String(value || "").trim().toUpperCase();
}

function findActiveAdminByUsername(username) {
  const normalizedUsername = String(username || "").trim().toLowerCase();

  return loadAdmins().find((admin) => {
    return (
      admin.isActive === true &&
      admin.role === "admin" &&
      String(admin.username || "").trim().toLowerCase() === normalizedUsername
    );
  }) || null;
}

function findActiveAdminByPlayFabId(playFabId) {
  const normalizedId = normalizePlayFabId(playFabId);
  if (!normalizedId) return null;

  return loadAdmins().find((admin) => {
    return (
      admin.isActive === true &&
      admin.role === "admin" &&
      normalizePlayFabId(admin.playFabId) === normalizedId
    );
  }) || null;
}

module.exports = {
  loadAdmins,
  findActiveAdminByUsername,
  findActiveAdminByPlayFabId,
  normalizePlayFabId
};
