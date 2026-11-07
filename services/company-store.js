"use strict";
const { randomUUID } = require("node:crypto");
const { MAX_ROSTER, MAX_INVITES, PAGE_SIZE, companyError } = require("./company-domain");

function missing() { return companyError(404, "COMPANY_NOT_FOUND", "Company not found."); }
function inviteMissing() { return companyError(404, "COMPANY_INVITE_NOT_FOUND", "That pending invite is unavailable or has expired."); }
function conflict(code, message) { return companyError(409, code, message); }
function company(row, viewerId) {
  return { id: row.id, name: row.name, moderatorId: row.moderator_id,
    moderatorDisplayName: row.moderator_name, createdAt: row.created_at,
    role: row.moderator_id === viewerId ? "moderator" : "member" };
}
function invitation(row) {
  return { id: row.id, companyId: row.company_id, playerId: row.player_id,
    displayName: row.display_name, createdAt: row.created_at, expiresAt: row.expires_at };
}
function page(rows, project) {
  const items = rows.slice(0, PAGE_SIZE);
  return { items: items.map(project), nextCursor: rows.length > PAGE_SIZE ? items.at(-1).id : null };
}

function createCompanyStore(pool) {
  async function tx(work) {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (_) { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }

  async function access(db, title, id, viewerId, { moderator = false, lock = "" } = {}) {
    // Lock choices are internal constants; user input is passed as parameters.
    const { rows: [row] } = await db.query(
      "SELECT * FROM road_companies WHERE title_id = $1 AND id = $2" + lock, [title, id]);
    if (!row) throw missing();
    if (row.moderator_id === viewerId) return row;
    const membership = await db.query(
      "SELECT 1 FROM road_company_members WHERE company_id = $1 AND player_id = $2", [id, viewerId]);
    if (!membership.rows.length) throw missing();
    if (moderator) throw companyError(403, "COMPANY_MODERATOR_REQUIRED", "Only this Company's Moderator can do that.");
    return row;
  }
  const assertModerator = (title, id, actor) => access(pool, title, id, actor, { moderator: true });

  async function create(title, actor, name) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO road_companies (id, title_id, name, moderator_id, moderator_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [randomUUID(), title, name, actor.id, actor.displayName]);
    return company(row, actor.id);
  }
  async function list(title, actor, after) {
    const { rows } = await pool.query(
      `SELECT c.* FROM road_companies c
       WHERE c.title_id = $1 AND ($3::uuid IS NULL OR c.id > $3)
         AND (c.moderator_id = $2 OR EXISTS (SELECT 1 FROM road_company_members m
              WHERE m.company_id = c.id AND m.player_id = $2))
       ORDER BY c.id LIMIT $4`, [title, actor, after, PAGE_SIZE + 1]);
    return page(rows, row => company(row, actor));
  }
  async function listInvites(title, actor, after) {
    const { rows } = await pool.query(
      `SELECT i.*, c.name AS company_name, c.moderator_name
       FROM road_company_invites i JOIN road_companies c ON c.id = i.company_id
       WHERE c.title_id = $1 AND i.player_id = $2 AND i.expires_at > now()
         AND ($3::uuid IS NULL OR i.id > $3)
       ORDER BY i.id LIMIT $4`, [title, actor, after, PAGE_SIZE + 1]);
    return page(rows, row => ({ ...invitation(row), companyName: row.company_name,
      moderatorDisplayName: row.moderator_name }));
  }
  async function roster(title, id, actor) {
    return tx(async db => {
      const row = await access(db, title, id, actor, { lock: " FOR SHARE" });
      const { rows } = await db.query(
        "SELECT player_id, display_name, joined_at FROM road_company_members WHERE company_id = $1 ORDER BY joined_at, player_id", [id]);
      const members = [{ playerId: row.moderator_id, displayName: row.moderator_name,
        role: "moderator", joinedAt: row.created_at },
      ...rows.map(member => ({ playerId: member.player_id, displayName: member.display_name,
        role: "member", joinedAt: member.joined_at }))];
      const result = { company: company(row, actor), members };
      if (row.moderator_id === actor) {
        const pending = await db.query(
          "SELECT * FROM road_company_invites WHERE company_id = $1 AND expires_at > now() ORDER BY created_at, id", [id]);
        result.pendingInvites = pending.rows.map(invitation);
      }
      return result;
    });
  }
  async function invite(title, id, actor, target) {
    return tx(async db => {
      await access(db, title, id, actor, { moderator: true, lock: " FOR UPDATE" });
      if (target.id === actor) throw conflict("COMPANY_ALREADY_MEMBER", "You already moderate this Company.");
      const { rows: [counts] } = await db.query(
        `SELECT (SELECT count(*)::int FROM road_company_members WHERE company_id = $1) AS members,
                (SELECT count(*)::int FROM road_company_invites WHERE company_id = $1 AND expires_at > now()) AS invites,
                EXISTS (SELECT 1 FROM road_company_members WHERE company_id = $1 AND player_id = $2) AS joined,
                EXISTS (SELECT 1 FROM road_company_invites WHERE company_id = $1 AND player_id = $2 AND expires_at > now()) AS invited`, [id, target.id]);
      if (counts.joined) throw conflict("COMPANY_ALREADY_MEMBER", "That builder is already a member.");
      if (counts.invited) throw conflict("COMPANY_INVITE_EXISTS", "That builder already has a pending invite.");
      if (counts.members >= MAX_ROSTER - 1) throw conflict("COMPANY_ROSTER_FULL", "This Company is full.");
      if (counts.invites >= MAX_INVITES) throw conflict("COMPANY_INVITES_FULL", "This Company has too many pending invites.");
      await db.query("DELETE FROM road_company_invites WHERE company_id = $1 AND expires_at <= now()", [id]);
      const { rows: [row] } = await db.query(
        `INSERT INTO road_company_invites (id, company_id, player_id, display_name)
         VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), id, target.id, target.displayName]);
      return invitation(row);
    });
  }
  async function respond(title, inviteId, actor, decision) {
    return tx(async db => {
      // Resolve only the invitee's own invitation, then lock the Company first.
      // Every mutation takes that same lock before changing membership/invites.
      const { rows: [initial] } = await db.query(
        `SELECT c.id FROM road_company_invites i JOIN road_companies c ON c.id = i.company_id
         WHERE c.title_id = $1 AND i.id = $2 AND i.player_id = $3 AND i.expires_at > now()`, [title, inviteId, actor.id]);
      if (!initial) throw inviteMissing();
      const { rows: [row] } = await db.query(
        "SELECT * FROM road_companies WHERE title_id = $1 AND id = $2 FOR UPDATE", [title, initial.id]);
      if (!row) throw inviteMissing();
      const pending = await db.query(
        "SELECT 1 FROM road_company_invites WHERE id = $1 AND company_id = $2 AND player_id = $3 AND expires_at > now()",
        [inviteId, row.id, actor.id]);
      if (!pending.rows.length) throw inviteMissing();
      if (decision === "accept") {
        if (row.moderator_id === actor.id) throw conflict("COMPANY_ALREADY_MEMBER", "You already moderate this Company.");
        const { rows: [capacity] } = await db.query(
          `SELECT count(*)::int AS count, COALESCE(bool_or(player_id = $2), false) AS joined
           FROM road_company_members WHERE company_id = $1`, [row.id, actor.id]);
        if (capacity.joined) throw conflict("COMPANY_ALREADY_MEMBER", "You already belong to this Company.");
        if (capacity.count >= MAX_ROSTER - 1) throw conflict("COMPANY_ROSTER_FULL", "This Company is full.");
        await db.query("INSERT INTO road_company_members (company_id, player_id, display_name) VALUES ($1, $2, $3)",
          [row.id, actor.id, actor.displayName]);
      }
      await db.query("DELETE FROM road_company_invites WHERE id = $1 AND company_id = $2 AND player_id = $3", [inviteId, row.id, actor.id]);
      return { decision, companyId: row.id };
    });
  }
  async function revoke(title, id, actor, inviteId) {
    return tx(async db => {
      await access(db, title, id, actor, { moderator: true, lock: " FOR UPDATE" });
      const result = await db.query("DELETE FROM road_company_invites WHERE company_id = $1 AND id = $2 AND expires_at > now() RETURNING id", [id, inviteId]);
      if (!result.rows.length) throw inviteMissing();
    });
  }
  async function remove(title, id, actor, target) {
    return tx(async db => {
      const self = actor === target;
      const row = await access(db, title, id, actor, { moderator: !self, lock: " FOR UPDATE" });
      if (row.moderator_id === target) throw conflict("COMPANY_MODERATOR_CANNOT_LEAVE", "The Moderator cannot leave or be removed in this version.");
      const result = await db.query("DELETE FROM road_company_members WHERE company_id = $1 AND player_id = $2 RETURNING player_id", [id, target]);
      if (!result.rows.length) throw companyError(404, "COMPANY_MEMBER_NOT_FOUND", "That builder is not a current member.");
    });
  }
  async function memberForSummary(title, id, actor, target) {
    await assertModerator(title, id, actor);
    const { rows: [row] } = await pool.query(
      "SELECT player_id, display_name FROM road_company_members WHERE company_id = $1 AND player_id = $2", [id, target]);
    if (!row) throw companyError(404, "COMPANY_MEMBER_NOT_FOUND", "That builder is not a current member.");
    return { playerId: row.player_id, displayName: row.display_name };
  }
  return { create, list, listInvites, roster, assertModerator, invite, respond, revoke, remove, memberForSummary };
}

module.exports = { createCompanyStore };
