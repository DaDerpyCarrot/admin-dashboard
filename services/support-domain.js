"use strict";
const { createHash } = require("node:crypto");
const CATEGORIES = Object.freeze(["bug", "suggestion", "account_help", "other"]);
const AREAS = Object.freeze(["game", "website", "account", "general"]);
const STATUSES = Object.freeze(["open", "in_review", "needs_reply", "resolved"]);
const PAGE_SIZE = 30;
const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\p{Cs}]/u;
function supportError(status, code, message) {
  return Object.assign(new Error(message), { status, code, publicSupportError: true });
}
const invalid = message => supportError(400, "SUPPORT_INVALID_INPUT", message);
const missing = () => supportError(404, "SUPPORT_NOT_FOUND", "Report not found.");
function titleId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{1,32}$/i.test(value.trim())) throw supportError(503, "SUPPORT_NOT_CONFIGURED", "Support is not configured yet.");
  return value.trim().toUpperCase();
}
function playerId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{3,64}$/i.test(value)) throw invalid("Invalid player identity.");
  return value.toUpperCase();
}
function uuid(value, label = "report reference") {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw invalid("Invalid " + label + ".");
  return value.toLowerCase();
}
function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid("Unexpected request fields.");
  return value;
}
function text(value, label, max, min = 0, multiline = true) {
  if (typeof value !== "string" || value.length > max * 2 || BAD.test(value) || (!multiline && /[\n\r\t]/.test(value))) throw invalid("Enter valid " + label + ".");
  const cleaned = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (Array.from(cleaned).length < min || Array.from(cleaned).length > max) throw invalid(`${label} must contain ${min}–${max} characters.`);
  return cleaned;
}
function oneOf(value, values, label) {
  if (!values.includes(value)) throw invalid("Choose a valid " + label + ".");
  return value;
}
function displayName(info) {
  for (const value of [info?.TitleInfo?.DisplayName, info?.Username]) {
    if (typeof value === "string" && value.trim() && !BAD.test(value) && !/[\r\n\t@<>]/.test(value)) return Array.from(value.trim()).slice(0, 100).join("");
  }
  return "Operator"; // Never fall back to a private email address.
}
function creation(value) {
  const b = object(value, ["requestId", "category", "area", "subject", "description", "steps", "expected", "actual", "gameVersion"]);
  return { requestId: uuid(b.requestId, "send reference"), category: oneOf(b.category, CATEGORIES, "category"),
    area: oneOf(b.area, AREAS, "area"), subject: text(b.subject, "Subject", 120, 3, false),
    description: text(b.description, "Description", 5000, 10),
    steps: text(b.steps ?? "", "Steps", 2000), expected: text(b.expected ?? "", "Expected result", 2000),
    actual: text(b.actual ?? "", "Actual result", 2000), gameVersion: text(b.gameVersion ?? "", "Game version", 40, 0, false) };
}
function reply(value, admin = false, internal = false) {
  const b = object(value, admin && !internal ? ["requestId", "body", "status"] : ["requestId", "body"]);
  return { requestId: uuid(b.requestId, "send reference"), body: text(b.body, internal ? "Note" : "Reply", 5000, 1),
    ...(admin && !internal ? { status: oneOf(b.status ?? "needs_reply", STATUSES, "status") } : {}) };
}
function patch(value) {
  const b = object(value, ["requestId", "expectedVersion", "status", "assignment"]);
  if (!Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 1 || b.expectedVersion > 2147483646) throw invalid("Refresh this report before changing its status.");
  if (b.status === undefined && b.assignment === undefined) throw invalid("Choose a status or assignment change.");
  return { requestId: uuid(b.requestId, "send reference"), expectedVersion: b.expectedVersion,
    ...(b.status === undefined ? {} : { status: oneOf(b.status, STATUSES, "status") }),
    ...(b.assignment === undefined ? {} : { assignment: oneOf(b.assignment, ["me", "unassigned"], "assignment") }) };
}
function positive(value, label, max = 9223372036854775807n) {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > max) throw invalid("Invalid " + label + ".");
  return value;
}
function listQuery(query, admin = false) {
  object(query, admin ? ["before", "limit", "status", "category", "area", "q", "playerId"] : ["before", "limit", "status", "category", "area"]);
  const result = { before: query.before === undefined ? null : positive(query.before, "list cursor"),
    limit: query.limit === undefined ? PAGE_SIZE : Number(positive(query.limit, "page size", 30n)) };
  if (query.status !== undefined) result.status = oneOf(query.status, STATUSES, "status");
  if (query.category !== undefined) result.category = oneOf(query.category, CATEGORIES, "category");
  if (query.area !== undefined) result.area = oneOf(query.area, AREAS, "area");
  if (admin && query.q !== undefined) result.q = text(query.q, "Search", 100, 1, false);
  if (admin && query.playerId !== undefined) result.playerId = playerId(query.playerId);
  return result;
}
function threadQuery(query) {
  object(query, ["after", "limit"]);
  return { after: query.after === undefined ? null : positive(query.after, "conversation cursor"),
    limit: query.limit === undefined ? PAGE_SIZE : Number(positive(query.limit, "page size", 30n)) };
}
function fingerprint(kind, value) {
  return createHash("sha256").update(JSON.stringify([kind, Object.fromEntries(Object.entries(value).filter(([key]) => key !== "requestId"))])).digest("hex");
}
function sameRequest(row, hash) {
  if (row.payload_hash !== hash) throw supportError(409, "SUPPORT_SEND_REFERENCE_REUSED", "This send reference was already used for different content. Check your report before sending again.");
}
const reference = number => "RD-" + String(number).padStart(6, "0");
function projectTicket(row, admin = false, detail = false) {
  const result = { id: row.id, reference: reference(row.ticket_no), category: row.category, area: row.area,
    subject: row.subject, status: row.status, gameVersion: row.game_version,
    createdAt: row.created_at, updatedAt: admin ? row.updated_at : row.public_updated_at };
  if (detail) Object.assign(result, { description: row.description, steps: row.steps, expected: row.expected, actual: row.actual });
  if (admin) Object.assign(result, { player: { playFabId: row.player_id, displayName: row.player_name },
    assignedTo: row.assigned_admin, version: row.version });
  return result;
}
function projectEntry(row, admin = false) {
  if (!admin && row.visibility !== "public") throw new Error("Internal support entry reached a player projection.");
  const result = { id: row.id, body: row.body, authorRole: row.author_role,
    authorName: row.author_role === "admin" && !admin ? "LNJK Support" : row.author_name, createdAt: row.created_at };
  if (admin) Object.assign(result, { visibility: row.visibility, authorId: row.author_id });
  return result;
}
module.exports = { CATEGORIES, AREAS, STATUSES, PAGE_SIZE, supportError, invalid, missing, titleId,
  playerId, uuid, object, text, displayName, creation, reply, patch, listQuery, threadQuery,
  fingerprint, sameRequest, reference, projectTicket, projectEntry };
