"use strict";
const express = require("express");
const { createHash } = require("node:crypto");
const { createCompanyStore } = require("../services/company-store");
const { PUBLIC_PROFILE_KEYS, companyError, invalid, playerId, uuid, name, publicName,
  body, pageCursor, projectProfile } = require("../services/company-domain");

const SESSION_CODES = new Set(["InvalidSessionTicket", "SessionTicketExpired", "NotAuthenticated", "AccountBanned"]);
const sessionError = () => companyError(401, "COMPANY_SESSION_REQUIRED", "Sign in again to use Companies.");
const upstreamError = () => companyError(503, "COMPANY_PLAYFAB_UNAVAILABLE", "Player information is temporarily unavailable. Please retry.");
const unavailable = () => companyError(503, "COMPANIES_UNAVAILABLE", "Companies are temporarily unavailable. Please retry.");

function providerCode(error) { return error?.details?.error; }
function isInvalidSession(error) { return error?.status === 401 || SESSION_CODES.has(providerCode(error)); }
function deadline(operation, ms) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(upstreamError()), ms); })
  ]).finally(() => clearTimeout(timer));
}

function createPlayerCompaniesRouter({ settings, store, authenticate, readAccount, readPublic,
  now = Date.now, upstreamTimeoutMs = 8000, logger = () => {} }) {
  const router = express.Router();
  const windows = new Map();
  function admit(res, key, limit) {
    const time = now();
    let window = windows.get(key);
    if (!window || time - window.at >= 60000) window = { at: time, count: 0 };
    if (window.count >= limit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((60000 - time + window.at) / 1000))));
      throw companyError(429, "COMPANY_RATE_LIMIT", "Too many Company requests. Please try again in a moment.");
    }
    window.count++;
    windows.delete(key);
    windows.set(key, window);
    if (windows.size > 6000) windows.delete(windows.keys().next().value);
  }

  router.use(async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const title = String(settings().title || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,32}$/.test(title)) throw unavailable();
    const header = req.headers.authorization;
    const ticket = typeof header === "string" && header.length <= 4103 ?
      /^Bearer ([^\s,]+)$/i.exec(header)?.[1] : null;
    if (!ticket || ticket.length < 20) throw sessionError();
    admit(res, "ticket:" + createHash("sha256").update(ticket).digest("hex"), 120);

    let result;
    try { result = await deadline(() => authenticate(ticket), upstreamTimeoutMs); }
    catch (error) { throw isInvalidSession(error) ? sessionError() : upstreamError(); }
    if (result?.data?.IsSessionTicketExpired === true) throw sessionError();
    const info = result?.data?.UserInfo;
    let id;
    try { id = playerId(info?.PlayFabId); } catch (_) { throw sessionError(); }
    const read = req.method === "GET" || req.method === "HEAD";
    admit(res, (read ? "read:" : "write:") + title + ":" + id, read ? 90 : 12);
    req.companyContext = { title, actor: { id, displayName: publicName(info) }, ticket };
    next();
  });

  router.get("/", async (req, res) => {
    const { title, actor } = req.companyContext;
    const result = await store().list(title, actor.id, pageCursor(req.query));
    res.json({ ok: true, companies: result.items, nextCursor: result.nextCursor });
  });
  router.post("/", async (req, res) => {
    const { title, actor } = req.companyContext;
    const label = name(body(req.body, ["name"]).name);
    const company = await store().create(title, actor, label);
    res.status(201).json({ ok: true, company });
  });
  router.get("/invites", async (req, res) => {
    const { title, actor } = req.companyContext;
    const result = await store().listInvites(title, actor.id, pageCursor(req.query));
    res.json({ ok: true, invites: result.items, nextCursor: result.nextCursor });
  });
  router.post("/invites/:inviteId/respond", async (req, res) => {
    const { title, actor } = req.companyContext;
    const inviteId = uuid(req.params.inviteId, "invite ID");
    const decision = body(req.body, ["decision"]).decision;
    if (decision !== "accept" && decision !== "decline") throw invalid("Choose accept or decline.");
    const result = await store().respond(title, inviteId, actor, decision);
    res.json({ ok: true, ...result });
  });
  router.get("/:companyId", async (req, res) => {
    const { title, actor } = req.companyContext;
    const result = await store().roster(title, uuid(req.params.companyId), actor.id);
    res.json({ ok: true, ...result });
  });
  router.post("/:companyId/invites", async (req, res) => {
    const { title, actor, ticket } = req.companyContext;
    const id = uuid(req.params.companyId);
    const target = playerId(body(req.body, ["playerId"]).playerId);
    const companyStore = store();
    await companyStore.assertModerator(title, id, actor.id);
    if (actor.id === target) throw companyError(409, "COMPANY_ALREADY_MEMBER", "You already moderate this Company.");
    let account;
    try { account = (await deadline(() => readAccount(ticket, target), upstreamTimeoutMs))?.data?.AccountInfo; }
    catch (error) {
      if (providerCode(error) === "AccountNotFound") throw companyError(404, "COMPANY_PLAYER_NOT_FOUND", "That builder could not be found.");
      throw isInvalidSession(error) ? sessionError() : upstreamError();
    }
    if (typeof account?.PlayFabId !== "string" || account.PlayFabId.toUpperCase() !== target) throw upstreamError();
    const invite = await companyStore.invite(title, id, actor.id, { id: target, displayName: publicName(account) });
    res.status(201).json({ ok: true, invite });
  });
  router.delete("/:companyId/invites/:inviteId", async (req, res) => {
    const { title, actor } = req.companyContext;
    await store().revoke(title, uuid(req.params.companyId), actor.id, uuid(req.params.inviteId, "invite ID"));
    res.json({ ok: true });
  });
  router.delete("/:companyId/membership", async (req, res) => {
    const { title, actor } = req.companyContext;
    await store().remove(title, uuid(req.params.companyId), actor.id, actor.id);
    res.json({ ok: true });
  });
  router.delete("/:companyId/members/:playerId", async (req, res) => {
    const { title, actor } = req.companyContext;
    const target = playerId(req.params.playerId);
    if (actor.id === target) throw invalid("Use the leave Company endpoint for your own membership.");
    await store().remove(title, uuid(req.params.companyId), actor.id, target);
    res.json({ ok: true });
  });
  router.get("/:companyId/members/:playerId/summary", async (req, res) => {
    const { title, actor, ticket } = req.companyContext;
    const id = uuid(req.params.companyId);
    const target = playerId(req.params.playerId);
    const companyStore = store();
    await companyStore.memberForSummary(title, id, actor.id, target);
    let result;
    try { result = await deadline(() => readPublic(ticket, target, PUBLIC_PROFILE_KEYS), upstreamTimeoutMs); }
    catch (error) { throw isInvalidSession(error) ? sessionError() : upstreamError(); }
    if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) throw upstreamError();
    const currentMember = await companyStore.memberForSummary(title, id, actor.id, target);
    res.json({ ok: true, member: { ...currentMember, ...projectProfile(result.data.Data) } });
  });
  router.use((_req, res) => {
    res.status(404).json({ ok: false, code: "COMPANY_ROUTE_NOT_FOUND", message: "Company endpoint not found." });
  });
  router.use((error, _req, res, _next) => {
    const safe = error?.publicCompanyError ? error :
      error?.code === "42P01" ? companyError(503, "COMPANIES_NOT_INITIALIZED", "Company storage setup is not complete.") :
      error instanceof URIError ? invalid("Invalid Company URL.") : unavailable();
    if (safe.status >= 500) logger(safe.code); // Never log tickets, profiles, or DB connection details.
    res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
  });
  return router;
}

function defaultRouter() {
  const playfab = () => require("../services/playfab");
  return createPlayerCompaniesRouter({
    settings: () => ({ title: process.env.PLAYFAB_TITLE_ID }),
    store: () => createCompanyStore(require("../services/ledger-db").getLedgerPool()),
    authenticate: ticket => playfab().authenticateSessionTicket(ticket),
    readAccount: (ticket, id) => playfab().callPlayFabAsPlayer("/Client/GetAccountInfo", ticket, { PlayFabId: id }),
    readPublic: (ticket, id, keys) => playfab().callPlayFabAsPlayer("/Client/GetUserData", ticket, { PlayFabId: id, Keys: keys }),
    logger: code => console.warn("Company request:", code)
  });
}

module.exports = { createPlayerCompaniesRouter, defaultRouter };
