"use strict";

const MAX_ROSTER = 50; // Includes the moderator.
const MAX_INVITES = 50; // Per company, pending only.
const PAGE_SIZE = 30;
const PUBLIC_PROFILE_KEYS = Object.freeze([
  "ProfileAvatar", "ProfileAboutMe", "ProfileTotalXP", "ProfileJobsCompleted", "ProfileJobsAttempted"
]);
const AVATARS = new Set([
  "avatar_roadbuilder", "avatar_maplecrew", "avatar_asphaltace", "avatar_pavepaws",
  "avatar_brickbuddy", "avatar_surveyor", "avatar_forewoman",
  "avatar_uniform_white_khaki", "avatar_uniform_white_khaki_male"
]);
const BAD_LABEL = /[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;

function companyError(status, code, message) {
  return Object.assign(new Error(message), { status, code, publicCompanyError: true });
}
function invalid(message) { return companyError(400, "COMPANY_INVALID_INPUT", message); }
function playerId(value) {
  if (typeof value !== "string" || !/^[A-F0-9]{3,64}$/i.test(value)) throw invalid("Invalid PlayFab player ID.");
  return value.toUpperCase();
}
function uuid(value, field = "Company ID") {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw invalid("Invalid " + field + ".");
  }
  return value.toLowerCase();
}
function name(value) {
  if (typeof value !== "string" || value.length > 240 || BAD_LABEL.test(value)) throw invalid("Enter a valid Company name.");
  const normalized = value.normalize("NFC").trim();
  if (Array.from(normalized).length < 3 || Array.from(normalized).length > 60 || /[<>]/.test(normalized)) {
    throw invalid("Company names must be 3–60 characters, without angle brackets.");
  }
  return normalized;
}
function publicName(info) {
  for (const candidate of [info?.TitleInfo?.DisplayName, info?.Username]) {
    if (typeof candidate === "string" && candidate.trim() && !BAD_LABEL.test(candidate) && !/[@<>]/.test(candidate)) {
      return Array.from(candidate.trim()).slice(0, 100).join("");
    }
  }
  return "Builder";
}
function body(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw invalid("Unexpected request fields.");
  return value;
}
function pageCursor(query) {
  if (Object.keys(query).some(key => key !== "after")) throw invalid("Unsupported list filter.");
  return query.after === undefined ? null : uuid(query.after, "list cursor");
}
function numberField(value) {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  const number = Number(value);
  return number <= 2147483647 ? number : null;
}
function projectProfile(values) {
  // The Client API already limits other-player reads to Public keys.
  // Reject missing/Private permission metadata too; never return a raw response.
  const read = key => values?.[key]?.Permission === "Public" ? values[key].Value : null;
  const avatar = read("ProfileAvatar");
  const bio = read("ProfileAboutMe");
  return {
    avatar: AVATARS.has(avatar) ? avatar : "avatar_roadbuilder",
    bio: typeof bio === "string" ? bio.slice(0, 1000) : "",
    xp: numberField(read("ProfileTotalXP")),
    completed: numberField(read("ProfileJobsCompleted")),
    attempted: numberField(read("ProfileJobsAttempted"))
  };
}

module.exports = { MAX_ROSTER, MAX_INVITES, PAGE_SIZE, PUBLIC_PROFILE_KEYS, companyError,
  invalid, playerId, uuid, name, publicName, body, pageCursor, projectProfile };
