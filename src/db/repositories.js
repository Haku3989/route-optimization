/**
 * Raw-SQL data-access layer (DAO) for the Excel Route Planning feature.
 *
 * Every statement uses PARAMETERIZED queries (`$1, $2, ...`) so untrusted values
 * (customer codes, uploaded cell values, usernames, tokens, filters) are passed
 * to Postgres separately from the SQL text. String concatenation of user values
 * into SQL is NEVER used here — this is the primary defence against SQL injection.
 *
 * Column mapping: JS records use camelCase (customerCode, shopName, serviceTimeMin,
 * openTime, closeTime, coordSource) while the DB uses snake_case (customer_code,
 * shop_name, service_time_min, open_time, close_time, coord_source). The write
 * helpers map camelCase -> snake_case columns; the join helpers map the selected
 * snake_case columns back to the camelCase shapes the services consume.
 *
 * This file currently holds the write + cross-workbook join functions (task 3.1).
 * The driver-auth functions (findDriverByUsername, insertSession, findSession,
 * deleteSession — task 3.2) are appended to the "Driver auth" section at the end.
 */

import { query } from "./pool.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a multi-row `VALUES` clause with sequential positional placeholders and
 * the flattened parameter array to go with it.
 *
 * Given `rows = [[a, b], [c, d]]` it returns:
 *   { text: "($1, $2), ($3, $4)", params: [a, b, c, d] }
 *
 * Every value ends up as a bound parameter — nothing is interpolated into SQL.
 *
 * @param {unknown[][]} rows  one inner array of column values per DB row
 * @returns {{ text: string, params: unknown[] }}
 */
function buildValuesClause(rows) {
  const params = [];
  const groups = [];
  let placeholder = 1;
  for (const row of rows) {
    const slots = row.map((value) => {
      params.push(value);
      return `$${placeholder++}`;
    });
    groups.push(`(${slots.join(", ")})`);
  }
  return { text: groups.join(", "), params };
}

/**
 * Map a joined `shops` (master) result row back to the camelCase shop shape the
 * services expect, or `null` when the LEFT JOIN found no matching Shop_Master
 * row. Presence is detected via `shop_customer_code` (the shops PK, which is
 * NULL only when nothing matched).
 *
 * `location` is `{ lat, lng }` only when BOTH coordinates are present; otherwise
 * it is `null` so callers can treat an unresolved shop uniformly.
 *
 * @param {Record<string, any>} row
 * @returns {{ location: {lat:number,lng:number}|null, serviceTimeMin: number|null,
 *             openTime: string|null, closeTime: string|null, coordSource: string|null } | null}
 */
function shopFromJoinRow(row) {
  if (row.shop_customer_code == null) {
    return null;
  }
  const location =
    row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null;
  return {
    location,
    serviceTimeMin: row.service_time_min ?? null,
    openTime: row.open_time ?? null,
    closeTime: row.close_time ?? null,
    coordSource: row.coord_source ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shops — upsert keyed on customer_code (Requirements 1.8, 2.5)
// ---------------------------------------------------------------------------

/**
 * Bulk upsert Shop_Master records keyed on `customer_code`.
 *
 * Uses `INSERT ... ON CONFLICT (customer_code) DO UPDATE` so re-uploading a
 * Shop_Master UPDATES existing rows instead of duplicating them. When the same
 * `customer_code` appears more than once in a single batch, the last occurrence
 * wins (deduped here because Postgres rejects an ON CONFLICT statement that would
 * touch the same conflict target row twice).
 *
 * @param {Array<{
 *   customerCode: string,
 *   shopName?: string|null,
 *   location?: { lat: number, lng: number }|null,
 *   coordSource?: string,
 *   serviceTimeMin?: number|null,
 *   openTime?: string|null,
 *   closeTime?: string|null,
 * }>} records
 * @returns {Promise<number>} number of rows written (inserted or updated)
 */
export async function upsertShops(records) {
  if (!records || records.length === 0) {
    return 0;
  }

  // Keep the last record per customer_code so a single batch never violates the
  // ON CONFLICT target twice.
  const byCode = new Map();
  for (const record of records) {
    byCode.set(record.customerCode, record);
  }

  const rows = [...byCode.values()].map((record) => [
    record.customerCode,
    record.shopName ?? null,
    record.location?.lat ?? null,
    record.location?.lng ?? null,
    record.coordSource ?? "unresolved",
    record.serviceTimeMin ?? null,
    record.openTime ?? null,
    record.closeTime ?? null,
  ]);

  const { text, params } = buildValuesClause(rows);
  const result = await query(
    `INSERT INTO shops
       (customer_code, shop_name, lat, lng, coord_source,
        service_time_min, open_time, close_time)
     VALUES ${text}
     ON CONFLICT (customer_code) DO UPDATE SET
       shop_name        = EXCLUDED.shop_name,
       lat              = EXCLUDED.lat,
       lng              = EXCLUDED.lng,
       coord_source     = EXCLUDED.coord_source,
       service_time_min = EXCLUDED.service_time_min,
       open_time        = EXCLUDED.open_time,
       close_time       = EXCLUDED.close_time`,
    params
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// History / Presale — append parsed rows (Requirements 3.1, 5.1)
// ---------------------------------------------------------------------------

/**
 * Bulk insert History_Workbook records.
 *
 * @param {Array<{
 *   customerCode: string,
 *   customerName?: string|null,
 *   dcName?: string|null,
 *   storeName?: string|null,
 *   invoiceDate?: string|Date|null,
 *   timeVisit?: string|Date|null,
 *   visitType?: string|null,
 *   storeGroup?: string|null,
 *   storeArea?: string|null,
 *   customerType?: string|null,
 *   quantity?: number|null,
 * }>} records
 * @returns {Promise<number>} number of rows inserted
 */
export async function insertHistoryEntries(records) {
  if (!records || records.length === 0) {
    return 0;
  }

  const rows = records.map((record) => [
    record.customerCode,
    record.customerName ?? null,
    record.dcName ?? null,
    record.storeName ?? null,
    record.invoiceDate ?? null,
    record.timeVisit ?? null,
    record.visitType ?? null,
    record.storeGroup ?? null,
    record.storeArea ?? null,
    record.customerType ?? null,
    record.quantity ?? null,
  ]);

  const { text, params } = buildValuesClause(rows);
  const result = await query(
    `INSERT INTO history_entries
       (customer_code, customer_name, dc_name, store_name, invoice_date,
        time_visit, visit_type, store_group, store_area, customer_type, quantity)
     VALUES ${text}`,
    params
  );
  return result.rowCount;
}

/**
 * Bulk insert Presale_Workbook records. `customerCode` is the prefix parsed out
 * of the Presale `CustomerName` and may be null when no leading code was present.
 *
 * @param {Array<{
 *   customerCode?: string|null,
 *   customerName?: string|null,
 *   deliveryDate?: string|Date|null,
 *   demand?: number|null,
 * }>} records
 * @returns {Promise<number>} number of rows inserted
 */
export async function insertPresaleEntries(records) {
  if (!records || records.length === 0) {
    return 0;
  }

  const rows = records.map((record) => [
    record.customerCode ?? null,
    record.customerName ?? null,
    record.deliveryDate ?? null,
    record.demand ?? null,
  ]);

  const { text, params } = buildValuesClause(rows);
  const result = await query(
    `INSERT INTO presale_entries
       (customer_code, customer_name, delivery_date, demand)
     VALUES ${text}`,
    params
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Cross-workbook joins on Customer_Code (Requirement 2.5 — master wins)
// ---------------------------------------------------------------------------

/**
 * Join every History entry to its Shop_Master row on `customer_code`.
 *
 * A `LEFT JOIN` keeps history rows that have no master match (their `shop` is
 * `null`). Coordinates, `service_time_min`, `open_time`, and `close_time` are
 * selected from the `shops` (master) columns so master data wins (Req 2.5).
 *
 * @returns {Promise<Array<{ history: object, shop: object|null }>>}
 */
export async function joinHistory() {
  const result = await query(
    `SELECT
       h.id,
       h.customer_code,
       h.customer_name,
       h.dc_name,
       h.store_name,
       h.invoice_date,
       h.time_visit,
       h.visit_type,
       h.store_group,
       h.store_area,
       h.customer_type,
       h.quantity,
       s.customer_code AS shop_customer_code,
       s.lat,
       s.lng,
       s.service_time_min,
       s.open_time,
       s.close_time,
       s.coord_source
     FROM history_entries h
     LEFT JOIN shops s ON s.customer_code = h.customer_code
     ORDER BY h.id`
  );

  return result.rows.map((row) => ({
    history: {
      id: row.id,
      customerCode: row.customer_code,
      customerName: row.customer_name,
      dcName: row.dc_name,
      storeName: row.store_name,
      invoiceDate: row.invoice_date,
      timeVisit: row.time_visit,
      visitType: row.visit_type,
      storeGroup: row.store_group,
      storeArea: row.store_area,
      customerType: row.customer_type,
      quantity: row.quantity,
    },
    shop: shopFromJoinRow(row),
  }));
}

/**
 * Join every Presale entry to its Shop_Master row on `customer_code`.
 *
 * A `LEFT JOIN` keeps presale rows that have no master match (their `shop` is
 * `null` — those customers become "unassigned" downstream). Coordinates,
 * `service_time_min`, `open_time`, and `close_time` come from the `shops`
 * (master) columns so master data wins (Req 2.5).
 *
 * @returns {Promise<Array<{ presale: object, shop: object|null }>>}
 */
export async function joinPresale() {
  const result = await query(
    `SELECT
       p.id,
       p.customer_code,
       p.customer_name,
       p.delivery_date,
       p.demand,
       s.customer_code AS shop_customer_code,
       s.lat,
       s.lng,
       s.service_time_min,
       s.open_time,
       s.close_time,
       s.coord_source
     FROM presale_entries p
     LEFT JOIN shops s ON s.customer_code = p.customer_code
     ORDER BY p.id`
  );

  return result.rows.map((row) => ({
    presale: {
      id: row.id,
      customerCode: row.customer_code,
      customerName: row.customer_name,
      deliveryDate: row.delivery_date,
      demand: row.demand,
    },
    shop: shopFromJoinRow(row),
  }));
}

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

/**
 * Truncate all feature tables and reset identity sequences. Used by integration
 * tests for isolation between cases. `CASCADE` also clears `driver_sessions`
 * rows referencing `drivers`.
 *
 * @returns {Promise<void>}
 */
export async function truncateAll() {
  await query(
    `TRUNCATE shops, history_entries, presale_entries, drivers, driver_sessions
     RESTART IDENTITY CASCADE`
  );
}

// ---------------------------------------------------------------------------
// Driver auth (Requirement 10) — added in task 3.2
// findDriverByUsername, insertSession, findSession, deleteSession
// ---------------------------------------------------------------------------

/**
 * Look up a driver by username for login.
 *
 * @param {string} username  the submitted employee username (bound as $1)
 * @returns {Promise<{ id: number, username: string, passwordHash: string,
 *                     routeId: string|null } | null>}
 *   the driver row mapped to camelCase, or `null` when no driver has that
 *   username (callers treat `null` as an authentication failure — Req 10.2).
 */
export async function findDriverByUsername(username) {
  const result = await query(
    `SELECT id, username, password_hash, route_id
       FROM drivers
      WHERE username = $1`,
    [username]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    routeId: row.route_id ?? null,
  };
}

/**
 * Persist an issued bearer token so the session survives restarts and is shared
 * across instances (Req 10.1). `created_at` defaults to `now()` in the schema.
 *
 * @param {string} token       opaque random bearer token (PK, bound as $1)
 * @param {number} driverId    owning driver id (bound as $2)
 * @param {string|Date|null} [expiresAt]  optional expiry; `null`/omitted means
 *   the session does not expire on a timestamp basis.
 * @returns {Promise<void>}
 */
export async function insertSession(token, driverId, expiresAt = null) {
  await query(
    `INSERT INTO driver_sessions (token, driver_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, driverId, expiresAt ?? null]
  );
}

/**
 * Resolve a bearer token to its session. Callers treat an absent row (or an
 * expired `expiresAt`) as unauthenticated (Req 10.3).
 *
 * @param {string} token  the bearer token to look up (bound as $1)
 * @returns {Promise<{ driverId: number, expiresAt: Date|null } | null>}
 *   the session mapped to camelCase, or `null` when no session has that token.
 */
export async function findSession(token) {
  const result = await query(
    `SELECT driver_id, expires_at
       FROM driver_sessions
      WHERE token = $1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    driverId: row.driver_id,
    expiresAt: row.expires_at ?? null,
  };
}

/**
 * Remove a session (logout, or cleanup of an expired token). Deleting a token
 * that does not exist is a no-op.
 *
 * @param {string} token  the bearer token to delete (bound as $1)
 * @returns {Promise<void>}
 */
export async function deleteSession(token) {
  await query(`DELETE FROM driver_sessions WHERE token = $1`, [token]);
}
