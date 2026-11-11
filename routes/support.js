"use strict";
const express = require("express");
const { createHash } = require("node:crypto");
const domain = require("../services/support-domain");
const { createSupportStore } = require("../services/support-store");
const { supportError, invalid, titleId, playerId, uuid, object, text, displayName } = domain;
const unavailable = () => supportError(503, "SUPPORT_UNAVAILABLE", "Support is temporarily unavailable. Please try again.");
const sessionError = () => supportError(401, "SUPPORT_SESSION_REQUIRED", "Sign in again to use Support Desk.");
const SESSION_ERRORS = new Set(["SessionTicketExpired", "InvalidSessionTicket", "NotAuthenticated", "AccountBanned"]);

function createSupportRouters({ settings, store, authenticatePlayer, verifyAdminToken,
  now = Date.now, upstreamTimeoutMs = 8000, logger = () => {} }) {
  if (typeof verifyAdminToken !== "function" || typeof authenticatePlayer !== "function") throw new Error("Support authentication providers are required.");
  const windows = new Map();
  let authenticating = 0;
  function admit(res, key, limit) {
    const time = now();
    let window = windows.get(key);
    if (!window || time - window.at >= 60000) window = { at: time, count: 0 };
    if (window.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((window.at + 60000 - time) / 1000));
      res.set("Retry-After", String(retryAfter));
      throw supportError(429, "SUPPORT_RATE_LIMIT", "Too many support requests. Please wait a moment and try again.");
    }
    window.count++;
    windows.delete(key); windows.set(key, window);
    if (windows.size > 8000) windows.delete(windows.keys().next().value);
  }
  function common(_req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  }
  async function playerAuth(req, res, next) {
    const title = titleId(settings().title);
    const header = req.headers.authorization;
    const ticket = typeof header === "string" && header.length <= 4103 ? /^Bearer ([^\s,]+)$/i.exec(header)?.[1] : null;
    if (!ticket || ticket.length < 20) throw sessionError();
    admit(res, "auth-total", 360);
    admit(res, "ticket:" + createHash("sha256").update(ticket).digest("hex"), 90);
    if (authenticating >= 16) throw unavailable();
    const controller = new AbortController();
    let timer, result;
    authenticating++;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => authenticatePlayer(ticket, controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, upstreamTimeoutMs); })
      ]);
    } catch (error) {
      if (error?.status === 401 || SESSION_ERRORS.has(error?.details?.error) || SESSION_ERRORS.has(error?.error)) throw sessionError();
      throw unavailable();
    } finally { clearTimeout(timer); authenticating--; }
    if (result?.data?.IsSessionTicketExpired === true) throw sessionError();
    const info = result?.data?.UserInfo;
    let owner;
    try { owner = playerId(info?.PlayFabId); } catch (_) { throw sessionError(); }
    const read = req.method === "GET" || req.method === "HEAD";
    admit(res, "player:" + title + ":" + owner + ":" + (read ? "read" : "write"), read ? 60 : 12);
    req.support = { title, actor: { role: "player", id: owner, name: displayName(info) } };
    next();
  }
  function adminAuth(req, res, next) {
    const title = titleId(settings().title);
    const actor = req.admin;
    const record = req.adminRecord;
    if (actor?.role !== "admin" || !record || record.isActive === false || record.username !== actor.username) {
      throw supportError(403, "SUPPORT_ADMIN_REQUIRED", "Administrator access is required.");
    }
    let username;
    try { username = text(actor.username, "admin identity", 128, 1, false); }
    catch (_) { throw supportError(403, "SUPPORT_ADMIN_REQUIRED", "Administrator access is required."); }
    const read = req.method === "GET" || req.method === "HEAD";
    admit(res, "admin:" + title + ":" + username + ":" + (read ? "read" : "write"), read ? 120 : 40);
    req.support = { title, actor: { role: "admin", id: username, name: Array.from(username).slice(0, 100).join("") } };
    next();
  }
  function jsonOnly(req, _res, next) {
    if (["POST", "PATCH"].includes(req.method)) object(req.query, []);
    if (["POST", "PATCH"].includes(req.method) && !req.is("application/json")) throw supportError(415, "SUPPORT_JSON_REQUIRED", "Send this request as JSON text. Attachments are not supported.");
    next();
  }
  function finish(router) {
    router.use((_req, res) => res.status(404).json({ ok: false, code: "SUPPORT_ROUTE_NOT_FOUND", message: "Support endpoint not found." }));
    router.use((error, _req, res, _next) => {
      const safe = error?.publicSupportError ? error : error?.type === "entity.too.large"
        ? supportError(413, "SUPPORT_TEXT_TOO_LARGE", "This report is too large. Shorten the text and try again.")
        : error?.type === "entity.parse.failed" || error instanceof URIError ? invalid("Invalid support request.")
        : error?.code === "42P01" || error?.code === "42703" ? supportError(503, "SUPPORT_NOT_INITIALIZED", "Support storage setup is not complete.") : unavailable();
      if (safe.status >= 500) logger(safe.code); // No request text, tokens, email or raw database errors.
      if (safe.retryAfter) res.set("Retry-After", String(safe.retryAfter));
      res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
    });
    return router;
  }
  const player = express.Router();
  player.use(common, playerAuth, jsonOnly, express.json({ limit: "32kb", strict: true }));
  player.post("/", async (req, res) => {
    const data = domain.creation(req.body);
    const result = await store().create(req.support, data);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
  });
  player.get("/", async (req, res) => res.json({ ok: true, ...await store().list(req.support, domain.listQuery(req.query)) }));
  player.get("/:id", async (req, res) => {
    object(req.query, []);
    res.json({ ok: true, ticket: await store().get(req.support, uuid(req.params.id)) });
  });
  player.get("/:id/messages", async (req, res) => res.json({ ok: true, ...await store().messages(req.support, uuid(req.params.id), domain.threadQuery(req.query)) }));
  player.post("/:id/replies", async (req, res) => {
    const result = await store().append(req.support, uuid(req.params.id), domain.reply(req.body));
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
  });

  const admin = express.Router();
  admin.use(common, verifyAdminToken, adminAuth, jsonOnly, express.json({ limit: "32kb", strict: true }));
  admin.get("/summary", async (req, res) => { object(req.query, []); res.json({ ok: true, ...await store().summary(req.support) }); });
  admin.get("/", async (req, res) => res.json({ ok: true, ...await store().list(req.support, domain.listQuery(req.query, true)) }));
  admin.get("/:id", async (req, res) => { object(req.query, []); res.json({ ok: true, ticket: await store().get(req.support, uuid(req.params.id)) }); });
  admin.get("/:id/messages", async (req, res) => res.json({ ok: true, ...await store().messages(req.support, uuid(req.params.id), domain.threadQuery(req.query)) }));
  admin.get("/:id/activity", async (req, res) => res.json({ ok: true, ...await store().activity(req.support, uuid(req.params.id), domain.threadQuery(req.query)) }));
  admin.patch("/:id", async (req, res) => res.json({ ok: true, ...await store().update(req.support, uuid(req.params.id), domain.patch(req.body)) }));
  for (const [path, internal] of [["replies", false], ["notes", true]]) admin.post("/:id/" + path, async (req, res) => {
    const result = await store().append(req.support, uuid(req.params.id), domain.reply(req.body, true, internal), internal);
    res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
  });
  return { player: finish(player), admin: finish(admin) };
}
function defaults() {
  return {
    settings: () => ({ title: process.env.PLAYFAB_TITLE_ID }),
    store: () => createSupportStore(require("../services/ledger-db").getLedgerPool()),
    authenticatePlayer: (ticket, signal) => require("../services/playfab").callPlayFab("/Server/AuthenticateSessionTicket", { SessionTicket: ticket }, { signal }),
    verifyAdminToken: require("../middleware/verifyAdminToken"),
    logger: code => console.warn("Support request:", code)
  };
}
module.exports = { createSupportRouters, defaultRouters: () => createSupportRouters(defaults()) };
