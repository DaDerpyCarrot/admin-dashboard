"use strict";
const { randomUUID } = require("node:crypto");
const { supportError, missing, fingerprint, sameRequest, projectTicket, projectEntry } = require("./support-domain");
const quota = message => Object.assign(supportError(429, "SUPPORT_SUBMISSION_LIMIT", message), { retryAfter: 3600 });
function createSupportStore(pool) {
  async function transaction(work) {
    const db = await pool.connect();
    let discard = false;
    try { await db.query("BEGIN"); const value = await work(db); await db.query("COMMIT"); return value; }
    catch (error) { try { await db.query("ROLLBACK"); } catch (_) { discard = true; } throw error; }
    finally { db.release(discard); }
  }
  const isAdmin = ctx => ctx.actor.role === "admin";
  async function access(db, ctx, id, lock = false) {
    const { rows: [row] } = await db.query(
      "SELECT * FROM road_support_tickets WHERE title_id=$1 AND id=$2 AND ($3::text IS NULL OR player_id=$3)" + (lock ? " FOR UPDATE" : ""),
      [ctx.title, id, isAdmin(ctx) ? null : ctx.actor.id]);
    if (!row) throw missing();
    return row;
  }
  async function lockActor(db, ctx) {
    // A transaction lock makes player quotas safe across server instances.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["road-support:" + ctx.title + ":" + ctx.actor.role + ":" + ctx.actor.id]);
  }
  async function receipt(db, ctx, id, requestId, hash) {
    const { rows: [row] } = await db.query(
      "SELECT * FROM road_support_activity WHERE ticket_id=$1 AND actor_role=$2 AND actor_id=$3 AND request_id=$4",
      [id, ctx.actor.role, ctx.actor.id, requestId]);
    if (row) sameRequest(row, hash);
    return row;
  }
  async function record(db, ctx, id, action, data, hash, changes = {}, entryId = null) {
    await db.query(`INSERT INTO road_support_activity
      (id,ticket_id,actor_role,actor_id,actor_name,action,request_id,payload_hash,changes,entry_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [randomUUID(), id, ctx.actor.role, ctx.actor.id, ctx.actor.name, action, data.requestId, hash, JSON.stringify(changes), entryId]);
  }
  async function create(ctx, data) {
    const hash = fingerprint("create", data);
    return transaction(async db => {
      await lockActor(db, ctx);
      const { rows: [previous] } = await db.query(
        "SELECT * FROM road_support_tickets WHERE title_id=$1 AND player_id=$2 AND request_id=$3", [ctx.title, ctx.actor.id, data.requestId]);
      if (previous) { sameRequest(previous, hash); return { ticket: projectTicket(previous, false, true), replayed: true }; }
      const { rows: [limits] } = await db.query(`SELECT
        count(*) FILTER (WHERE created_at > now()-interval '1 hour')::int AS hourly,
        count(*) FILTER (WHERE created_at > now()-interval '1 day')::int AS daily,
        count(*) FILTER (WHERE status <> 'resolved')::int AS active
        FROM road_support_tickets WHERE title_id=$1 AND player_id=$2`, [ctx.title, ctx.actor.id]);
      if (limits.hourly >= 3 || limits.daily >= 12) throw quota("You’ve sent several reports recently. Please wait before starting another.");
      if (limits.active >= 10) throw supportError(409, "SUPPORT_TOO_MANY_OPEN", "You already have several open reports. Add a reply to an existing report instead.");
      const { rows: [row] } = await db.query(`INSERT INTO road_support_tickets
        (id,title_id,player_id,player_name,request_id,payload_hash,category,area,subject,description,steps,expected,actual,game_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [randomUUID(), ctx.title, ctx.actor.id, ctx.actor.name, data.requestId, hash, data.category, data.area,
        data.subject, data.description, data.steps, data.expected, data.actual, data.gameVersion]);
      await record(db, ctx, row.id, "created", data, hash, { status: { from: null, to: "open" } });
      return { ticket: projectTicket(row, false, true), replayed: false };
    });
  }
  async function list(ctx, filter) {
    const args = [ctx.title];
    const where = ["title_id=$1"];
    const add = (sql, value) => { args.push(value); where.push(sql.replace("?", "$" + args.length)); };
    if (!isAdmin(ctx)) add("player_id=?", ctx.actor.id);
    else if (filter.playerId) add("player_id=?", filter.playerId);
    for (const key of ["status", "category", "area"]) if (filter[key]) add(key + "=?", filter[key]);
    if (filter.before) add("ticket_no < ?::bigint", filter.before);
    if (filter.q) {
      args.push("%" + filter.q.replace(/[\\%_]/g, "\\$&") + "%");
      const p = "$" + args.length;
      where.push(`(subject ILIKE ${p} OR player_name ILIKE ${p} OR player_id ILIKE ${p}
        OR ('RD-' || lpad(ticket_no::text,greatest(6,length(ticket_no::text)),'0')) ILIKE ${p})`);
    }
    args.push(filter.limit + 1);
    const { rows } = await pool.query(`SELECT * FROM road_support_tickets WHERE ${where.join(" AND ")}
      ORDER BY ticket_no DESC LIMIT $${args.length}`, args);
    const selected = rows.slice(0, filter.limit);
    return { tickets: selected.map(row => projectTicket(row, isAdmin(ctx))),
      nextCursor: rows.length > filter.limit ? String(selected.at(-1).ticket_no) : null };
  }
  async function get(ctx, id) { return projectTicket(await access(pool, ctx, id), isAdmin(ctx), true); }
  async function messages(ctx, id, query) {
    await access(pool, ctx, id);
    // Filter private notes in SQL BEFORE limiting the player conversation.
    const { rows } = await pool.query(`SELECT * FROM road_support_entries WHERE ticket_id=$1
      AND ($2::boolean OR visibility='public') AND ($3::bigint IS NULL OR entry_no>$3)
      ORDER BY entry_no LIMIT $4`, [id, isAdmin(ctx), query.after, query.limit + 1]);
    const selected = rows.slice(0, query.limit);
    return { messages: selected.map(row => projectEntry(row, isAdmin(ctx))),
      nextCursor: rows.length > query.limit ? String(selected.at(-1).entry_no) : null };
  }
  async function append(ctx, id, data, internal = false) {
    const admin = isAdmin(ctx);
    if (internal && !admin) throw missing();
    const action = internal ? "internal_note" : admin ? "admin_reply" : "player_reply";
    const hash = fingerprint(action, data);
    return transaction(async db => {
      await lockActor(db, ctx);
      const row = await access(db, ctx, id, true);
      const previous = await receipt(db, ctx, id, data.requestId, hash);
      if (previous) {
        const { rows: [entry] } = await db.query("SELECT * FROM road_support_entries WHERE id=$1 AND ticket_id=$2", [previous.entry_id, id]);
        return { ticket: projectTicket(row, admin), message: projectEntry(entry, admin), replayed: true };
      }
      if (!admin) {
        const { rows: [limits] } = await db.query(`SELECT count(*)::int AS count FROM road_support_entries e
          JOIN road_support_tickets t ON t.id=e.ticket_id WHERE t.title_id=$1 AND e.author_role='player'
          AND e.author_id=$2 AND e.created_at > now()-interval '1 hour'`, [ctx.title, ctx.actor.id]);
        if (limits.count >= 20) throw quota("You’ve sent several replies recently. Please wait before sending another.");
      }
      const visibility = internal ? "internal" : "public";
      const { rows: [size] } = await db.query("SELECT count(*)::int AS count FROM road_support_entries WHERE ticket_id=$1 AND visibility=$2", [id, visibility]);
      if (size.count >= 500) throw supportError(409, "SUPPORT_THREAD_FULL", "This report has reached its reply limit. Start a new report and include its reference.");
      const { rows: [entry] } = await db.query(`INSERT INTO road_support_entries
        (id,ticket_id,visibility,author_role,author_id,author_name,body) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), id, visibility, ctx.actor.role, ctx.actor.id, ctx.actor.name, data.body]);
      const status = internal ? row.status : admin ? data.status : row.status === "in_review" ? "in_review" : "open";
      const { rows: [updated] } = await db.query(`UPDATE road_support_tickets SET status=$2,version=version+1,
        updated_at=now(),public_updated_at=CASE WHEN $3::boolean THEN public_updated_at ELSE now() END
        WHERE id=$1 RETURNING *`, [id, status, internal]);
      await record(db, ctx, id, action, data, hash, status === row.status ? {} : { status: { from: row.status, to: status } }, entry.id);
      return { ticket: projectTicket(updated, admin), message: projectEntry(entry, admin), replayed: false };
    });
  }
  async function update(ctx, id, data) {
    if (!isAdmin(ctx)) throw missing();
    const hash = fingerprint("updated", data);
    return transaction(async db => {
      const row = await access(db, ctx, id, true);
      if (await receipt(db, ctx, id, data.requestId, hash)) return { ticket: projectTicket(row, true, true), replayed: true };
      if (row.version !== data.expectedVersion) throw supportError(409, "SUPPORT_CHANGED", "This report changed while you were viewing it. Refresh before saving your changes.");
      const status = data.status ?? row.status;
      const assigned = data.assignment === "me" ? ctx.actor.id : data.assignment === "unassigned" ? null : row.assigned_admin;
      const changes = {};
      if (status !== row.status) changes.status = { from: row.status, to: status };
      if (assigned !== row.assigned_admin) changes.assignment = { from: row.assigned_admin, to: assigned };
      const { rows: [updated] } = await db.query(`UPDATE road_support_tickets SET status=$2,assigned_admin=$3,
        version=version+1,updated_at=now(),public_updated_at=CASE WHEN status<>$2 THEN now() ELSE public_updated_at END
        WHERE id=$1 RETURNING *`, [id, status, assigned]);
      await record(db, ctx, id, "updated", data, hash, changes);
      return { ticket: projectTicket(updated, true, true), replayed: false };
    });
  }
  async function activity(ctx, id, query) {
    if (!isAdmin(ctx)) throw missing();
    await access(pool, ctx, id);
    const { rows } = await pool.query(`SELECT * FROM road_support_activity WHERE ticket_id=$1
      AND ($2::bigint IS NULL OR event_no>$2) ORDER BY event_no LIMIT $3`, [id, query.after, query.limit + 1]);
    const selected = rows.slice(0, query.limit);
    return { activity: selected.map(row => ({ id: row.id, action: row.action,
      actor: { role: row.actor_role, id: row.actor_id, name: row.actor_name }, changes: row.changes, createdAt: row.created_at })),
    nextCursor: rows.length > query.limit ? String(selected.at(-1).event_no) : null };
  }
  async function summary(ctx) {
    if (!isAdmin(ctx)) throw missing();
    const { rows } = await pool.query("SELECT status,count(*)::int AS count FROM road_support_tickets WHERE title_id=$1 GROUP BY status", [ctx.title]);
    const counts = { open: 0, in_review: 0, needs_reply: 0, resolved: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return { counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0), needsAttention: counts.open + counts.in_review };
  }
  return { create, list, get, messages, append, update, activity, summary };
}
module.exports = { createSupportStore };
