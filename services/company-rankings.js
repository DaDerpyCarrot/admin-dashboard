"use strict";
const { MAX_ROSTER, companyError, invalid, playerId, publicName } = require("./company-domain");

const STATS = Object.freeze({ xp: "TotalXP", completed: "JobsCompleted",
  activity: "JobsAttempted", earnings: "ContractCashEarned" });
const STAT_NAMES = Object.freeze(Object.values(STATS));
const LIMIT = 20;
const TTL = 45000;
const MAX_SNAPSHOTS = 100;
const MAX_BUILDS = 3;
const PARALLEL = 6;
const MAX_SCORE = 2147483647;
const score = value => Number.isInteger(value) && value >= 0 && value <= MAX_SCORE;
const unavailable = () => companyError(503, "COMPANY_BOARD_UNAVAILABLE",
  "Company rankings are temporarily unavailable. Try Refresh board in a moment.");
const changed = () => companyError(409, "COMPANY_BOARD_ROSTER_CHANGED", "The Company roster changed. Refresh the board to get the current rankings.");

function boardMetric(query) {
  if (Object.keys(query).length !== 1 || typeof query.metric !== "string" || !Object.hasOwn(STATS, query.metric)) {
    throw invalid("Choose a supported Company ranking category.");
  }
  return query.metric;
}

function memberIds(roster, actor) {
  if (!Array.isArray(roster?.members) || !roster.members.length || roster.members.length > MAX_ROSTER) throw unavailable();
  const ids = roster.members.map(member => playerId(member.playerId)).sort();
  if (new Set(ids).size !== ids.length || !ids.includes(actor)) throw unavailable();
  return ids;
}

function readScores(result, id) {
  const data = result?.data;
  if (typeof data?.PlayFabId !== "string" || data.PlayFabId.toUpperCase() !== id || !Array.isArray(data.Statistics)) {
    throw unavailable();
  }
  const values = new Map();
  for (const row of data.Statistics) {
    if (!STAT_NAMES.includes(row?.StatisticName)) continue;
    if (!score(row.Value) || !score(row.Version) || values.has(row.StatisticName)) throw unavailable();
    values.set(row.StatisticName, { value: row.Value, version: row.Version });
  }
  return values;
}

function rankMembers(roster, scores, stat, actor) {
  const ranked = [];
  let version;
  for (const member of roster.members) {
    const id = playerId(member.playerId);
    const entry = scores.get(id)?.get(stat);
    if (!entry) continue;
    if (version !== undefined && entry.version !== version) throw unavailable();
    version = entry.version;
    ranked.push({ id, name: publicName({ TitleInfo: { DisplayName: member.displayName } }), score: entry.value });
  }
  // Equal scores share rank; the stable ID order is used only to decide display order.
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  let previous, rank = 0;
  const rows = ranked.map((row, index) => {
    if (row.score !== previous) rank = index + 1;
    previous = row.score;
    return { rank, name: row.name, score: row.score, isYou: row.id === actor };
  });
  const own = rows.find(row => row.isYou);
  return { rows: rows.slice(0, LIMIT), rankedCount: rows.length, memberCount: roster.members.length,
    placement: own ? { state: "ranked", rank: own.rank, score: own.score } : { state: "unranked" } };
}

function createCompanyRankings({ readStats, now = Date.now, timeoutMs = 10000 }) {
  const cache = new Map();
  const inFlight = new Map();
  async function collect(ids) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const scores = new Map();
    let next = 0;
    try {
      const workers = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL, ids.length) }, async () => {
        try {
          while (!controller.signal.aborted && next < ids.length) {
            const id = ids[next++];
            scores.set(id, readScores(await readStats(id, STAT_NAMES, controller.signal), id));
          }
        } catch (_) {
          controller.abort();
          throw unavailable();
        }
      }));
      if (controller.signal.aborted || workers.some(worker => worker.status === "rejected") || scores.size !== ids.length) {
        throw unavailable();
      }
      return { scores, snapshotAt: now() };
    } finally { clearTimeout(timer); }
  }
  async function snapshot(key, ids) {
    const saved = cache.get(key);
    if (saved && now() - saved.snapshotAt < TTL) return saved;
    cache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= MAX_BUILDS) throw unavailable();
    const job = collect(ids).then(result => {
      cache.set(key, result);
      if (cache.size > MAX_SNAPSHOTS) cache.delete(cache.keys().next().value);
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }
  return async ({ title, companyId, actor, metric, loadRoster }) => {
    const before = await loadRoster();
    const ids = memberIds(before, actor);
    const signature = ids.join(",");
    const { scores, snapshotAt } = await snapshot(title + ":" + companyId + ":" + signature, ids);
    // Don't hold a database transaction across PlayFab calls. Recheck access and
    // membership after the read, including cache hits, before returning any rankings.
    const current = await loadRoster();
    if (memberIds(current, actor).join(",") !== signature) throw changed();
    return {
      company: { id: companyId, name: current.company.name },
      metric, snapshotAt, ...rankMembers(current, scores, STATS[metric], actor)
    };
  };
}

module.exports = { boardMetric, createCompanyRankings };
