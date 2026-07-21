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

import { query, withTransaction } from "./pool.js";

/**
 * Postgres caps a single statement at 65535 bind parameters (the wire protocol
 * encodes the parameter count in a 16-bit field). A large workbook upload can
 * easily exceed that with a single multi-row INSERT — when it does, the count
 * overflows and the server rejects it with the confusing
 * "bind message has N parameter formats but 0 parameters" error.
 *
 * Staying comfortably below the hard limit lets us split a big batch into
 * several INSERTs (run together in one transaction) instead of overflowing.
 */
const MAX_BIND_PARAMS = 60000;

/**
 * Split `rows` into chunks small enough that `columnsPerRow * chunkRows` never
 * exceeds {@link MAX_BIND_PARAMS}. Always yields at least one row per chunk.
 *
 * @param {unknown[][]} rows
 * @param {number} columnsPerRow
 * @returns {unknown[][][]}
 */
function chunkRowsForBind(rows, columnsPerRow) {
  const maxRowsPerChunk = Math.max(1, Math.floor(MAX_BIND_PARAMS / columnsPerRow));
  if (rows.length <= maxRowsPerChunk) {
    return [rows];
  }
  const chunks = [];
  for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
    chunks.push(rows.slice(i, i + maxRowsPerChunk));
  }
  return chunks;
}

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

  // 8 columns per row — chunk so a large master file never overflows the
  // bind-parameter limit. Dedup above guarantees each customer_code appears
  // once overall, so no chunk (nor any pair of chunks) touches the same
  // ON CONFLICT target twice.
  const chunks = chunkRowsForBind(rows, 8);
  return withTransaction(async (client) => {
    let written = 0;
    for (const chunk of chunks) {
      const { text, params } = buildValuesClause(chunk);
      const result = await client.query(
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
      written += result.rowCount;
    }
    return written;
  });
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

  // 11 columns per row — chunk so a large history file is inserted as several
  // statements within one transaction instead of a single oversized INSERT.
  const chunks = chunkRowsForBind(rows, 11);
  return withTransaction(async (client) => {
    let inserted = 0;
    for (const chunk of chunks) {
      const { text, params } = buildValuesClause(chunk);
      const result = await client.query(
        `INSERT INTO history_entries
           (customer_code, customer_name, dc_name, store_name, invoice_date,
            time_visit, visit_type, store_group, store_area, customer_type, quantity)
         VALUES ${text}`,
        params
      );
      inserted += result.rowCount;
    }
    return inserted;
  });
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
 *   dcName?: string|null,
 *   storeName?: string|null,
 *   storeGroup?: string|null,
 *   storeArea?: string|null,
 *   customerType?: string|null,
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
    record.dcName ?? null,
    record.storeName ?? null,
    record.storeGroup ?? null,
    record.storeArea ?? null,
    record.customerType ?? null,
  ]);

  // 9 columns per row — chunk for parity with the other bulk writers so an
  // unusually large presale file cannot overflow the bind-parameter limit.
  const chunks = chunkRowsForBind(rows, 9);
  return withTransaction(async (client) => {
    let inserted = 0;
    for (const chunk of chunks) {
      const { text, params } = buildValuesClause(chunk);
      const result = await client.query(
        `INSERT INTO presale_entries
           (customer_code, customer_name, delivery_date, demand,
            dc_name, store_name, store_group, store_area, customer_type)
         VALUES ${text}`,
        params
      );
      inserted += result.rowCount;
    }
    return inserted;
  });
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
       p.dc_name,
       p.store_name,
       p.store_group,
       p.store_area,
       p.customer_type,
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
      dcName: row.dc_name,
      storeName: row.store_name,
      storeGroup: row.store_group,
      storeArea: row.store_area,
      customerType: row.customer_type,
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
    `TRUNCATE shops, history_entries, presale_entries,
              drivers, driver_sessions, admins, admin_sessions
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
 * Look up a driver by id — used to resolve an authenticated driver's OWN
 * assigned store (`routeId`) so their route view can be scoped to just their
 * vehicle within a presale plan, instead of every driver seeing every route.
 *
 * @param {number} id
 * @returns {Promise<{ id: number, username: string, routeId: string|null } | null>}
 */
export async function findDriverById(id) {
  const result = await query(
    `SELECT id, username, route_id FROM drivers WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, username: row.username, routeId: row.route_id ?? null };
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

// ---------------------------------------------------------------------------
// Admin auth — mirrors the driver auth helpers above for the admin portal.
// findAdminByUsername, insertAdminSession, findAdminSession, deleteAdminSession
// ---------------------------------------------------------------------------

/**
 * Look up an admin by username for login.
 *
 * @param {string} username  the submitted admin username (bound as $1)
 * @returns {Promise<{ id: number, username: string, passwordHash: string } | null>}
 *   the admin row mapped to camelCase, or `null` when no admin has that username
 *   (callers treat `null` as a generic authentication failure).
 */
export async function findAdminByUsername(username) {
  const result = await query(
    `SELECT id, username, password_hash
       FROM admins
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
  };
}

/**
 * Persist an issued admin bearer token. `created_at` defaults to `now()`.
 *
 * @param {string} token       opaque random bearer token (PK, bound as $1)
 * @param {number} adminId     owning admin id (bound as $2)
 * @param {string|Date|null} [expiresAt]  optional expiry; `null`/omitted means
 *   the session does not expire on a timestamp basis.
 * @returns {Promise<void>}
 */
export async function insertAdminSession(token, adminId, expiresAt = null) {
  await query(
    `INSERT INTO admin_sessions (token, admin_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, adminId, expiresAt ?? null]
  );
}

/**
 * Resolve an admin bearer token to its session, joining `admins` so the caller
 * can echo the username (e.g. GET /api/admin/me) without a second query. An
 * absent row (or an expired `expiresAt`) is treated as unauthenticated.
 *
 * @param {string} token  the bearer token to look up (bound as $1)
 * @returns {Promise<{ adminId: number, username: string, expiresAt: Date|null } | null>}
 */
export async function findAdminSession(token) {
  const result = await query(
    `SELECT s.admin_id, s.expires_at, a.username
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token = $1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    adminId: row.admin_id,
    username: row.username,
    expiresAt: row.expires_at ?? null,
  };
}

/**
 * Remove an admin session (logout / expired-token cleanup). Deleting a token
 * that does not exist is a no-op.
 *
 * @param {string} token  the bearer token to delete (bound as $1)
 * @returns {Promise<void>}
 */
export async function deleteAdminSession(token) {
  await query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}

// ---------------------------------------------------------------------------
// Filter option lists — distinct values from the uploaded history data, used to
// populate the dashboard/planner filter dropdowns.
// ---------------------------------------------------------------------------

/**
 * Distinct, non-empty values for each categorical History column, sorted
 * ascending. Column names are hardcoded constants (never user input), so the
 * interpolation below carries no injection risk; the only user-controlled
 * values (`activeFilters`) are bound as parameters, never interpolated.
 *
 * Cascading ("data hierarchy") behavior: when `activeFilters` selects a value
 * for one or more OTHER columns, each column's own distinct-values query is
 * scoped (`WHERE otherColumn = $n ...`) by every other active filter — so,
 * e.g., picking a `dcName` narrows the returned `storeName` list to that DC's
 * stores. A column is never scoped by its OWN active filter, so its current
 * selection stays selectable alongside its sibling values. DC_Name and
 * StoreName form a strict one-to-many chain in this data; Store Area and
 * CustomerType are looser co-occurrence facets, so this scopes every column
 * by every other active one rather than assuming a single fixed tree.
 *
 * @param {{ dcName?:string, storeName?:string, storeGroup?:string,
 *   storeArea?:string, customerType?:string }} [activeFilters] currently
 *   selected filter values (only non-empty strings count as "active")
 * @returns {Promise<{ dcName:string[], storeName:string[], storeGroup:string[],
 *   storeArea:string[], customerType:string[] }>}
 */
export async function distinctHistoryFilterValues(activeFilters = {}) {
  const columns = [
    ["dcName", "dc_name"],
    ["storeName", "store_name"],
    ["storeGroup", "store_group"],
    ["storeArea", "store_area"],
    ["customerType", "customer_type"],
  ];

  // Only non-empty string values count as "active" scoping filters.
  const active = {};
  for (const [key, column] of columns) {
    const value = activeFilters[key];
    if (typeof value === "string" && value.trim() !== "") {
      active[column] = value;
    }
  }

  const result = {};
  for (const [key, column] of columns) {
    const conditions = [`${column} IS NOT NULL`, `${column} <> ''`];
    const params = [];
    for (const [otherColumn, value] of Object.entries(active)) {
      if (otherColumn === column) continue; // never self-scope
      params.push(value);
      conditions.push(`${otherColumn} = $${params.length}`);
    }

    const rows = await query(
      `SELECT DISTINCT ${column} AS value
         FROM history_entries
        WHERE ${conditions.join(" AND ")}
        ORDER BY value`,
      params
    );
    result[key] = rows.rows.map((row) => row.value);
  }
  return result;
}

/**
 * Overview counts of the uploaded History data, grouped by DC_Name and by
 * StoreName: total visit rows and distinct customers per group, sorted
 * descending by customer count (busiest first). Used by the dashboard to show
 * a breakdown when no filter narrows the comparison down to a routable set,
 * instead of just a bare "too many customers" message.
 *
 * `byStore`'s `dcName` uses `MIN(dc_name)` as a stand-in for "the" DC a store
 * belongs to — safe here because a StoreName never spans more than one
 * DC_Name in this data (see `data/dcList.js`'s DC-per-store design).
 *
 * @returns {Promise<{
 *   byDc: Array<{ dcName:string, visits:number, customers:number }>,
 *   byStore: Array<{ storeName:string, dcName:string|null, visits:number, customers:number }>
 * }>}
 */
export async function historyOverview() {
  const [byDcRows, byStoreRows] = await Promise.all([
    query(`
      SELECT dc_name AS dc_name,
             COUNT(*)::int AS visits,
             COUNT(DISTINCT customer_code)::int AS customers
        FROM history_entries
       WHERE dc_name IS NOT NULL AND dc_name <> ''
       GROUP BY dc_name
       ORDER BY customers DESC, dc_name
    `),
    query(`
      SELECT store_name AS store_name,
             MIN(dc_name) AS dc_name,
             COUNT(*)::int AS visits,
             COUNT(DISTINCT customer_code)::int AS customers
        FROM history_entries
       WHERE store_name IS NOT NULL AND store_name <> ''
       GROUP BY store_name
       ORDER BY customers DESC, store_name
    `),
  ]);

  return {
    byDc: byDcRows.rows.map((row) => ({
      dcName: row.dc_name,
      visits: row.visits,
      customers: row.customers,
    })),
    byStore: byStoreRows.rows.map((row) => ({
      storeName: row.store_name,
      dcName: row.dc_name,
      visits: row.visits,
      customers: row.customers,
    })),
  };
}

/**
 * Distinct History `invoice_date` values (as `YYYY-MM-DD` strings, ascending)
 * that actually have data, scoped by whatever categorical filters are
 * currently active — same cascading pattern as
 * {@link distinctHistoryFilterValues}, but for the day-picker: routes are
 * calculated per store PER DAY, so the filter only ever offers days that
 * have data for the current DC/Store/etc. selection instead of an open date
 * range that might match nothing.
 *
 * @param {{ dcName?:string, storeName?:string, storeGroup?:string,
 *   storeArea?:string, customerType?:string }} [activeFilters]
 * @returns {Promise<string[]>}
 */
export async function distinctHistoryDates(activeFilters = {}) {
  const columnByKey = {
    dcName: "dc_name",
    storeName: "store_name",
    storeGroup: "store_group",
    storeArea: "store_area",
    customerType: "customer_type",
  };

  const conditions = ["invoice_date IS NOT NULL"];
  const params = [];
  for (const [key, column] of Object.entries(columnByKey)) {
    const value = activeFilters[key];
    if (typeof value === "string" && value.trim() !== "") {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }

  const result = await query(
    `SELECT DISTINCT invoice_date::text AS date
       FROM history_entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY date`,
    params
  );
  return result.rows.map((row) => row.date);
}

// ---------------------------------------------------------------------------
// Backfill geocoding — find customers/shops that still need coordinates.
// ---------------------------------------------------------------------------

/**
 * Distinct customer_codes present in History but with NO Shop_Master row at
 * all, paired with the best available geocode query (StoreName preferred,
 * then CustomerName, then DC_Name) and a representative customer name.
 * Powers the backfill-geocoding job (`services/backfillService.js`), which
 * persists a real shops row for each of these.
 *
 * @returns {Promise<Array<{ customerCode:string, geocodeQuery:string|null, customerName:string|null }>>}
 */
export async function findHistoryOnlyCustomers() {
  const result = await query(`
    SELECT h.customer_code AS customer_code,
           MIN(COALESCE(NULLIF(h.store_name, ''), NULLIF(h.customer_name, ''), NULLIF(h.dc_name, ''))) AS geocode_query,
           MIN(NULLIF(h.customer_name, '')) AS customer_name
      FROM history_entries h
      LEFT JOIN shops s ON s.customer_code = h.customer_code
     WHERE s.customer_code IS NULL
     GROUP BY h.customer_code
     ORDER BY h.customer_code
  `);
  return result.rows.map((row) => ({
    customerCode: row.customer_code,
    geocodeQuery: row.geocode_query,
    customerName: row.customer_name,
  }));
}

/**
 * Existing shop rows whose coordinates never resolved (`lat IS NULL`), with
 * their own name as the geocode query plus their other fields so a backfill
 * UPDATE can carry them through unchanged (only `lat`/`lng`/`coord_source`
 * should change here).
 *
 * @returns {Promise<Array<{ customerCode:string, geocodeQuery:string|null,
 *   shopName:string|null, serviceTimeMin:number|null, openTime:string|null, closeTime:string|null }>>}
 */
export async function findUnresolvedShops() {
  const result = await query(`
    SELECT customer_code, NULLIF(shop_name, '') AS shop_name,
           service_time_min, open_time, close_time
      FROM shops
     WHERE lat IS NULL
     ORDER BY customer_code
  `);
  return result.rows.map((row) => ({
    customerCode: row.customer_code,
    geocodeQuery: row.shop_name,
    shopName: row.shop_name,
    serviceTimeMin: row.service_time_min,
    openTime: row.open_time,
    closeTime: row.close_time,
  }));
}

/**
 * Whether all three workbook types have at least one row — used to decide
 * whether to trigger the backfill-geocoding job after an upload (Requirement:
 * auto-process once all 3 files are in, no filter/manual step needed).
 *
 * @returns {Promise<boolean>}
 */
export async function hasAllWorkbookTypes() {
  const result = await query(`
    SELECT
      EXISTS (SELECT 1 FROM shops) AS has_shops,
      EXISTS (SELECT 1 FROM history_entries) AS has_history,
      EXISTS (SELECT 1 FROM presale_entries) AS has_presale
  `);
  const row = result.rows[0];
  return Boolean(row.has_shops && row.has_history && row.has_presale);
}

// ---------------------------------------------------------------------------
// Database viewer — aggregate summary + paginated raw-row browsing over the
// three uploaded workbooks' tables, for the admin "Database" page.
// ---------------------------------------------------------------------------

/** Clamp a raw page/pageSize pair to sane, bounded values. */
function normalizePaging(page, pageSize) {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  const size = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 50;
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/**
 * Aggregate counts across all three tables, plus a shops resolution
 * breakdown (resolved = has lat/lng, regardless of source). Powers the
 * database viewer page's summary panel.
 *
 * @returns {Promise<{
 *   shops: { total:number, resolved:number, unresolved:number },
 *   history: { total:number, distinctCustomers:number },
 *   presale: { total:number, distinctCustomers:number },
 * }>}
 */
export async function databaseSummary() {
  const [shopsRow, historyRow, presaleRow] = await Promise.all([
    query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE lat IS NOT NULL)::int AS resolved
        FROM shops
    `),
    query(`
      SELECT COUNT(*)::int AS total, COUNT(DISTINCT customer_code)::int AS distinct_customers
        FROM history_entries
    `),
    query(`
      SELECT COUNT(*)::int AS total, COUNT(DISTINCT customer_code)::int AS distinct_customers
        FROM presale_entries
    `),
  ]);

  const shops = shopsRow.rows[0];
  const history = historyRow.rows[0];
  const presale = presaleRow.rows[0];

  return {
    shops: { total: shops.total, resolved: shops.resolved, unresolved: shops.total - shops.resolved },
    history: { total: history.total, distinctCustomers: history.distinct_customers },
    presale: { total: presale.total, distinctCustomers: presale.distinct_customers },
  };
}

/**
 * A page of raw `shops` rows, newest-code-first is meaningless here so
 * ordered by customer_code for a stable, predictable page sequence.
 * @returns {Promise<{ rows:Array<object>, total:number, page:number, pageSize:number }>}
 */
export async function listShopsPage({ page, pageSize } = {}) {
  const p = normalizePaging(page, pageSize);
  const [rows, count] = await Promise.all([
    query(
      `SELECT customer_code, shop_name, lat, lng, coord_source,
              service_time_min, open_time, close_time
         FROM shops
        ORDER BY customer_code
        LIMIT $1 OFFSET $2`,
      [p.pageSize, p.offset]
    ),
    query(`SELECT COUNT(*)::int AS n FROM shops`),
  ]);
  return {
    rows: rows.rows.map((r) => ({
      customerCode: r.customer_code,
      shopName: r.shop_name,
      lat: r.lat,
      lng: r.lng,
      coordSource: r.coord_source,
      serviceTimeMin: r.service_time_min,
      openTime: r.open_time,
      closeTime: r.close_time,
    })),
    total: count.rows[0].n,
    page: p.page,
    pageSize: p.pageSize,
  };
}

/** A page of raw `history_entries` rows, most recent id first. */
export async function listHistoryPage({ page, pageSize } = {}) {
  const p = normalizePaging(page, pageSize);
  const [rows, count] = await Promise.all([
    query(
      `SELECT id, customer_code, customer_name, dc_name, store_name, invoice_date,
              time_visit, store_group, store_area, customer_type, quantity
         FROM history_entries
        ORDER BY id DESC
        LIMIT $1 OFFSET $2`,
      [p.pageSize, p.offset]
    ),
    query(`SELECT COUNT(*)::int AS n FROM history_entries`),
  ]);
  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      customerCode: r.customer_code,
      customerName: r.customer_name,
      dcName: r.dc_name,
      storeName: r.store_name,
      invoiceDate: r.invoice_date,
      timeVisit: r.time_visit,
      storeGroup: r.store_group,
      storeArea: r.store_area,
      customerType: r.customer_type,
      quantity: r.quantity,
    })),
    total: count.rows[0].n,
    page: p.page,
    pageSize: p.pageSize,
  };
}

/** A page of raw `presale_entries` rows, most recent id first. */
export async function listPresalePage({ page, pageSize } = {}) {
  const p = normalizePaging(page, pageSize);
  const [rows, count] = await Promise.all([
    query(
      `SELECT id, customer_code, customer_name, delivery_date, demand,
              dc_name, store_name, store_group, store_area, customer_type
         FROM presale_entries
        ORDER BY id DESC
        LIMIT $1 OFFSET $2`,
      [p.pageSize, p.offset]
    ),
    query(`SELECT COUNT(*)::int AS n FROM presale_entries`),
  ]);
  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      customerCode: r.customer_code,
      customerName: r.customer_name,
      deliveryDate: r.delivery_date,
      demand: r.demand,
      dcName: r.dc_name,
      storeName: r.store_name,
      storeGroup: r.store_group,
      storeArea: r.store_area,
      customerType: r.customer_type,
    })),
    total: count.rows[0].n,
    page: p.page,
    pageSize: p.pageSize,
  };
}

// ---------------------------------------------------------------------------
// User management (admin "User Setup" console) — CRUD over admins + drivers.
// All are admin-gated at the route layer; passwords arrive pre-hashed here.
// ---------------------------------------------------------------------------

/**
 * List all admins (id + username only; never the password hash).
 * @returns {Promise<Array<{ id:number, username:string }>>}
 */
export async function listAdmins() {
  const result = await query(`SELECT id, username FROM admins ORDER BY username`);
  return result.rows.map((row) => ({ id: row.id, username: row.username }));
}

/**
 * List all drivers (id, username, assigned route; never the password hash).
 * @returns {Promise<Array<{ id:number, username:string, routeId:string|null }>>}
 */
export async function listDrivers() {
  const result = await query(
    `SELECT id, username, route_id FROM drivers ORDER BY username`
  );
  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    routeId: row.route_id ?? null,
  }));
}

/**
 * Count admin rows — used to refuse deleting the last remaining admin.
 * @returns {Promise<number>}
 */
export async function countAdmins() {
  const result = await query(`SELECT COUNT(*)::int AS n FROM admins`);
  return result.rows[0]?.n ?? 0;
}

/**
 * Insert a new admin. Returns the created row, or `null` when the username is
 * already taken (ON CONFLICT DO NOTHING yields no row).
 *
 * @param {string} username
 * @param {string} passwordHash  pre-hashed "scrypt$..." string
 * @returns {Promise<{ id:number, username:string }|null>}
 */
export async function createAdmin(username, passwordHash) {
  const result = await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username`,
    [username, passwordHash]
  );
  const row = result.rows[0];
  return row ? { id: row.id, username: row.username } : null;
}

/**
 * Insert a new driver. Returns the created row, or `null` when the username is
 * already taken.
 *
 * @param {string} username
 * @param {string} passwordHash  pre-hashed "scrypt$..." string
 * @param {string|null} [routeId]
 * @returns {Promise<{ id:number, username:string, routeId:string|null }|null>}
 */
export async function createDriver(username, passwordHash, routeId = null) {
  const result = await query(
    `INSERT INTO drivers (username, password_hash, route_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, route_id`,
    [username, passwordHash, routeId ?? null]
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, username: row.username, routeId: row.route_id ?? null }
    : null;
}

/**
 * Reset an admin's password. Returns the number of rows updated (0 = no such id).
 * @param {number} id
 * @param {string} passwordHash
 * @returns {Promise<number>}
 */
export async function updateAdminPassword(id, passwordHash) {
  const result = await query(
    `UPDATE admins SET password_hash = $2 WHERE id = $1`,
    [id, passwordHash]
  );
  return result.rowCount;
}

/**
 * Reset a driver's password. Returns the number of rows updated (0 = no such id).
 * @param {number} id
 * @param {string} passwordHash
 * @returns {Promise<number>}
 */
export async function updateDriverPassword(id, passwordHash) {
  const result = await query(
    `UPDATE drivers SET password_hash = $2 WHERE id = $1`,
    [id, passwordHash]
  );
  return result.rowCount;
}

/**
 * Delete an admin by id (cascades to their sessions). Returns rows deleted.
 * @param {number} id
 * @returns {Promise<number>}
 */
export async function deleteAdminById(id) {
  const result = await query(`DELETE FROM admins WHERE id = $1`, [id]);
  return result.rowCount;
}

/**
 * Delete a driver by id (cascades to their sessions). Returns rows deleted.
 * @param {number} id
 * @returns {Promise<number>}
 */
export async function deleteDriverById(id) {
  const result = await query(`DELETE FROM drivers WHERE id = $1`, [id]);
  return result.rowCount;
}
