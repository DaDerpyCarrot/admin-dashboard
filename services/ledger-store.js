"use strict";
const { ledgerError } = require("./ledger-domain");
const COLUMNS = `id::text, title_id, player_id, purchase_id, item_id, catalog_version, currency_code,
  unit_price::text, quantity::text, total_price::text, original_timestamp, captured_at,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_timestamp`;
function sameReceipt(row, event) {
  return row.title_id === event.titleId && row.player_id === event.playerId
    && row.purchase_id === event.purchaseId && row.item_id === event.itemId
    && row.catalog_version === event.catalogVersion && row.currency_code === event.currency
    && String(row.unit_price) === event.unitPrice && String(row.quantity) === event.quantity
    && String(row.total_price) === event.total;
}
function createLedgerStore(pool) {
  async function captureUsing(client, event) {
    const values = [event.titleId, event.playerId, event.purchaseId, event.itemId, event.catalogVersion,
      event.currency, event.unitPrice, event.quantity, event.total, event.occurredAt];
    const inserted = await client.query(`INSERT INTO road_purchase_transactions
      (title_id,player_id,purchase_id,item_id,catalog_version,currency_code,unit_price,quantity,total_price,occurred_at,original_timestamp)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,($10::text)::timestamptz,$10::text)
      ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`, values);
    let row = inserted.rows[0];
    if (!row) {
      const existing = await client.query(`SELECT ${COLUMNS} FROM road_purchase_transactions
        WHERE title_id=$1 AND player_id=$2 AND purchase_id=$3 AND item_id=$4 AND catalog_version=$5 AND currency_code=$6`, values.slice(0, 6));
      row = existing.rows[0];
      if (!row || !sameReceipt(row, event)) throw ledgerError("Conflicting data for an existing purchase. No history record was overwritten.", 409, "LEDGER_CONFLICT");
    }
    const alias = await client.query(`INSERT INTO road_purchase_events (title_id,event_id,transaction_id,fingerprint)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`, [event.titleId, event.eventId, row.id, event.fingerprint]);
    if (!alias.rows.length) {
      const existing = await client.query("SELECT transaction_id::text, fingerprint FROM road_purchase_events WHERE title_id=$1 AND event_id=$2", [event.titleId, event.eventId]);
      if (existing.rows[0]?.transaction_id !== row.id || existing.rows[0]?.fingerprint !== event.fingerprint) {
        throw ledgerError("Conflicting data for an existing event. No history record was overwritten.", 409, "LEDGER_CONFLICT");
      }
    }
    return { id: row.id, inserted: inserted.rows.length > 0 };
  }
  async function captureBatch(events) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const event of events) results.push(await captureUsing(client, event));
      await client.query("COMMIT");
      return results;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function list({ title, owner, filter, limit, page }) {
    const snapshot = page?.snapshot || (await pool.query("SELECT COALESCE(MAX(id),0)::text AS maximum FROM road_purchase_transactions WHERE title_id=$1 AND player_id=$2", [title, owner])).rows[0].maximum;
    const values = [title, owner, snapshot];
    const conditions = ["title_id=$1", "player_id=$2", "id<=$3::bigint"];
    const add = (clause, value) => { values.push(value); conditions.push(clause.replace("?", `$${values.length}`)); };
    if (filter.currency) add("currency_code=?", filter.currency);
    if (filter.from) add("occurred_at>=?::timestamptz", filter.from);
    if (filter.before) add("occurred_at<?::timestamptz", filter.before);
    if (filter.q) {
      values.push(filter.q);
      conditions.push(`(strpos(lower(item_id),lower($${values.length}))>0 OR strpos(lower(purchase_id),lower($${values.length}))>0)`);
    }
    if (page) {
      values.push(page.at, page.id);
      conditions.push(`(occurred_at,id)<($${values.length - 1}::timestamptz,$${values.length}::bigint)`);
    }
    values.push(limit + 1);
    const result = await pool.query(`SELECT ${COLUMNS} FROM road_purchase_transactions WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC,id DESC LIMIT $${values.length}`, values);
    const codes = await pool.query("SELECT DISTINCT currency_code FROM road_purchase_transactions WHERE title_id=$1 AND player_id=$2 ORDER BY currency_code", [title, owner]);
    return { rows: result.rows.slice(0, limit), hasMore: result.rows.length > limit, snapshot,
      currencies: codes.rows.map(row => row.currency_code) };
  }
  return { capture: event => captureBatch([event]).then(results => results[0]), captureBatch, list };
}
module.exports = { createLedgerStore, sameReceipt };
