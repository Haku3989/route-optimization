# Design Document: Excel Route Planning

## Overview

This feature layers three planning capabilities on top of the existing Farmhouse route-optimization prototype:

1. **History comparison** — compare the original (historical) delivery order against an AI-optimized order, with per-customer ETA and filtering.
2. **Presale re-planning** — build and optimize a route from the Presale customer list, honouring capacity, per-stop service time, and working-time windows.
3. **Driver app** — an authenticated, mobile-friendly view that lets a driver follow the optimized stop order with Google Maps handoff.

All three are fed by a new **Excel ingestion layer** that reads three workbook types, validates their schemas (including Thai column headers), maps rows into internal records, and joins them across workbooks on `Customer_Code`.

### Design goals and reuse strategy

The existing system is treated as a stable core and is **reused, not rewritten**:

| Existing module | Role in this feature | Change |
| --- | --- | --- |
| `src/optimizer/vrp.js` | Orders stops (nearest-neighbour + 2-opt) | Reused as-is; consumes the same `{ id, customer, demand, location }` order shape |
| `src/optimizer/distance.js` | Distance matrix / haversine + detour | Reused as-is |
| `src/optimizer/emissions.js` | CO₂ factors | Reused as-is |
| `src/routing/router.js` | Per-leg distance/time (estimator / Longdo) | Reused; a **companion geocoder** is added in the routing layer reusing `LONGDO_API_KEY` |
| `src/services/etaService.js` | Per-stop ETA | **Extended** (backward-compatibly) for per-stop `service_time_min` and time-window flags |
| `src/services/routeService.js` | Plan orchestration | Reused; new services call `planDeliveries` |
| `src/routes/api.js` | REST endpoints | **Extended** with new routers |
| `src/server.js` | Express app, static, error handler | Reused; mounts new routers and static driver page |
| `public/` | Leaflet dashboard | Reused; a new `driver.html` / `driver.js` is added |

The order shape is preserved. New per-stop fields (`serviceTimeMin`, `openTime`, `closeTime`, `address`) are **optional** and simply pass through the optimizer (which only reads `id`, `demand`, `location`), so existing sample flows are unaffected.

### Key research findings

- **Excel parsing library**: [ExcelJS](https://www.npmjs.com/package/exceljs) (pin `exceljs@^4.4.0`) is an actively maintained, pure-JavaScript reader/writer with no native build step, and it can load a workbook directly from an in-memory buffer (`workbook.xlsx.load(buffer)`). This fits the prototype's ES-module, dependency-light setup better than SheetJS (which now publishes its latest builds outside the public npm registry). Content was rephrased for compliance with licensing restrictions.
- **Multipart upload**: [multer](https://www.npmjs.com/package/multer) (pin `multer@^1.4.5-lts.1`) with `memoryStorage` gives an in-memory `Buffer` that is handed straight to ExcelJS — no temp files, no disk cleanup. The existing `express.json({ limit: "1mb" })` handler does **not** parse `multipart/form-data`, so a dedicated middleware is required on the upload route only.
- **Longdo geocoding**: Longdo exposes an address search / geocoding endpoint (`https://search.longdo.com/mapsearch/json/search`) authenticated with the same `key` query parameter already used by the routing layer. This lets the geocoder reuse `LONGDO_API_KEY` and mirror the existing estimator/Longdo provider pattern in `router.js`. Content was rephrased for compliance with licensing restrictions.
- **PostgreSQL access**: [node-postgres (`pg`)](https://www.npmjs.com/package/pg) (pin `pg@^8`) is the standard, actively maintained PostgreSQL client for Node. It supports a shared connection `Pool` and **parameterized queries** (`$1`, `$2`, …) that pass values separately from the SQL text, which is the primary defence against SQL injection. Raw SQL is used directly — **no ORM and no query builder** — keeping the data layer explicit and dependency-light. Content was rephrased for compliance with licensing restrictions.

### Configuration

The Postgres connection is configured entirely through **environment variables**, following the existing env-based config pattern (the same way `LONGDO_API_KEY` configures the routing layer). Either a single `DATABASE_URL` (e.g. `postgres://user:pass@host:5432/dbname`) or the standard discrete `PG*` variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) are read by `pg` — no credentials are hard-coded. A separate `DATABASE_URL` pointing at a disposable schema is used for integration tests.

## Architecture

### Component map

```mermaid
flowchart TB
  subgraph Client
    DASH[Dashboard public/index.html]
    DRV[Driver view public/driver.html]
  end

  subgraph API[src/routes]
    UP[/POST /api/ingest/upload/]
    HC[/POST /api/history/compare/]
    PP[/POST /api/presale/plan/]
    DL[/POST /api/driver/login/]
    DR[/GET /api/driver/route/]
  end

  subgraph Ingestion[src/ingestion]
    PARSE[excelParser.js]
    SCHEMA[schema.js]
    MAP[mappers.js]
    CODE[customerCode.js]
  end

  subgraph Data[src/db]
    POOL[pool.js shared pg Pool]
    REPO[repositories.js raw SQL DAO]
    SCH[schema.sql tables]
  end

  PG[(PostgreSQL)]

  subgraph Services[src/services]
    HSVC[historyService.js]
    PSVC[presaleService.js]
    DSVC[driverService.js]
    RSVC[routeService.js existing]
    ETA[etaService.js extended]
  end

  subgraph Core[existing core]
    VRP[optimizer/vrp.js]
    GEO[routing/geocoder.js new]
    RTR[routing/router.js]
    AUTH[auth/credentials.js new]
  end

  DASH --> UP & HC & PP
  DRV --> DL & DR
  UP --> PARSE --> SCHEMA --> MAP --> REPO
  MAP --> CODE
  MAP --> GEO --> RTR
  HC --> HSVC --> REPO
  PP --> PSVC --> REPO
  HSVC & PSVC --> RSVC --> VRP & ETA
  DL --> DSVC --> AUTH
  DSVC --> REPO
  DR --> DSVC
  REPO --> POOL --> PG
  SCH -.defines.-> PG
```

### New / changed directory layout

```
src/
  ingestion/
    excelParser.js     Load buffer -> { headers, rows, rowCount } (first worksheet)
    schema.js          Workbook-type schemas, classification, required-column validation
    mappers.js         Rows -> records (shop / history / presale), warnings collection
    customerCode.js    Parse Customer_Code prefix out of Presale CustomerName
  db/
    pool.js            NEW: shared pg Pool built from DATABASE_URL / PG* env vars
    repositories.js    NEW: raw parameterized SQL DAO (shops, history, presale,
                       drivers, sessions); cross-workbook JOINs on Customer_Code
    schema.sql         NEW: CREATE TABLE definitions for all tables
    seedDrivers.js     NEW: inserts driver rows (username + scrypt hash) — no plaintext
  routing/
    geocoder.js        NEW: estimator (null) / Longdo geocoder, reuses LONGDO_API_KEY
    router.js          existing
  auth/
    credentials.js     NEW: scrypt password hashing + token issue/verify
  services/
    historyService.js  NEW: history comparison (reads via repositories)
    presaleService.js  NEW: presale plan (reads via repositories)
    driverService.js   NEW: driver auth + route retrieval + stop advancement (via repositories)
    etaService.js       EXTENDED: per-stop service time + time-window flags
    routeService.js     existing
  routes/
    api.js              EXTENDED: mounts new sub-routers
    ingestRoutes.js     NEW
    historyRoutes.js    NEW
    presaleRoutes.js    NEW
    driverRoutes.js     NEW
public/
  driver.html / driver.js / driver.css   NEW mobile driver view
```

### Request lifecycle

Uploads write parsed records into PostgreSQL through the repository layer (`INSERT ... ON CONFLICT` upserts for shops keyed on `Customer_Code`). History and presale endpoints read from Postgres via repository queries that perform the cross-workbook join on `Customer_Code` with SQL `JOIN`s, apply filters, run the optimizer/ETA via `routeService`, and return results. The driver endpoints authenticate against the `drivers` table, persist the issued token in `driver_sessions`, and return the assigned route resolved through the repositories. Because state lives in Postgres, uploaded data and driver sessions survive process restarts and are shared across instances.

## Components and Interfaces

### Excel ingestion layer

**`excelParser.js`**

```js
// parseWorkbook(buffer) -> { headers: string[], rows: object[], rowCount: number }
// - Loads the first worksheet only (Requirement 1.1).
// - Each row is an object keyed by the trimmed header text of column 1..N.
// - Throws IngestionError("not a readable .xlsx workbook") if ExcelJS cannot load it.
export async function parseWorkbook(buffer) { /* ExcelJS workbook.xlsx.load */ }
```

**`schema.js`**

```js
// Workbook type definitions with required columns (Requirement 1.4).
export const WORKBOOK_SCHEMAS = {
  history:    { required: ["Customer_Code", "TIME_VISIT", "จำนวนลง"],
                optional: ["Customer_Name","DC_Name","StoreName","InvoiceDate","VISIT_TYPE","StoreGroup","Store Area","CustomerType"] },
  shopMaster: { required: ["Customer_code", "lat", "long", "service_time_min", "open_time", "close_time"],
                optional: ["shop_name", "วันเข้าร้าน"] },
  presale:    { required: ["CustomerName", "DELIVERY_DATE", "จำนวน Presale"], optional: [] },
};

// classifyWorkbook(headers, hint?) -> "history" | "shopMaster" | "presale"
//   Uses an explicit hint (from the upload form) when provided, else infers from headers.
export function classifyWorkbook(headers, hint) { /* ... */ }

// validateColumns(type, headers) -> { ok: boolean, missing: string[] }
export function validateColumns(type, headers) { /* ... */ }
```

**`customerCode.js`**

```js
// Presale CustomerName is "<Customer_Code> <name...>" (code prefix + name).
// parseCustomerCode("12345 ร้านสมชาย") -> { code: "12345", name: "ร้านสมชาย" }
// Returns { code: null, ... } when no leading code token is present.
export function parseCustomerCode(customerName) { /* ... */ }
```

**`mappers.js`**

```js
// Each mapper returns { records, warnings }.
// warnings: Array<{ row:number, reason:string, id?:string }>
// Rows missing a required value are EXCLUDED and recorded (Requirement 1.5, 1.6, 1.7).

export function mapShopMasterRows(rows) { /* -> ShopRecord[] */ }
export function mapHistoryRows(rows)    { /* -> HistoryEntry[] */ }
export function mapPresaleRows(rows)    { /* -> PresaleEntry[] (code parsed) */ }
```

### Coordinate resolution — `routing/geocoder.js`

Mirrors the estimator/Longdo pattern of `router.js` and reuses `LONGDO_API_KEY`.

```js
// createGeocoder({ apiKey?, baseUrl? }) -> Geocoder
// Geocoder.geocode(address) -> Promise<{ lat, lng } | null>
//   - EstimatorGeocoder: returns null (no network, no key) — every unresolved
//     shop is flagged rather than guessed.
//   - LongdoGeocoder: queries the Longdo search/geocoding endpoint.

// resolveShopCoordinates(shop, geocoder) -> Promise<{ location|null, resolved, source, reason? }>
//   Precedence (Requirement 2.1, 2.2, 2.4):
//     1. numeric lat/long AND not (0,0)      -> use directly (source: "master")
//     2. otherwise, geocode address/name     -> use if returned AND not (0,0) (source: "longdo")
//     3. otherwise                            -> resolved:false, reason (source: "unresolved")
```

`(0,0)` and non-numeric coordinates are treated as unresolved (Requirement 2.4).

### Data layer — `db/pool.js` + `db/repositories.js` + `db/schema.sql`

Uploaded data, driver credentials, and driver sessions are persisted in **PostgreSQL**, accessed through the [`pg`](https://www.npmjs.com/package/pg) library using **raw parameterized SQL** — no ORM and no query builder.

**`db/pool.js` — shared connection pool**

```js
// A single shared pg Pool built from env config (DATABASE_URL or PG* vars),
// mirroring the env-based pattern used for LONGDO_API_KEY.
import pg from "pg";
export const pool = new pg.Pool(/* reads DATABASE_URL / PGHOST / PGPORT / ... */);
// query(text, params) -> Promise<pg.Result>  thin wrapper around pool.query
export function query(text, params) { return pool.query(text, params); }
export async function close() { await pool.end(); }   // graceful shutdown / test teardown
```

**`db/repositories.js` — raw-SQL data-access layer (DAO)**

Every statement uses **parameterized queries** (`$1`, `$2`, …) so untrusted values (customer codes, filters, uploaded cell values, usernames, tokens) are passed to Postgres separately from the SQL text. **String concatenation of user values into SQL is never used**, which is the primary defence against SQL injection.

```js
// --- Shops (upsert keyed on customer_code) ---
// upsertShops(records) — bulk INSERT ... ON CONFLICT (customer_code) DO UPDATE
//   so re-uploading a Shop_Master updates existing rows instead of duplicating them.
export async function upsertShops(records) {
  // INSERT INTO shops (customer_code, shop_name, lat, lng, coord_source,
  //                    service_time_min, open_time, close_time)
  // VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  // ON CONFLICT (customer_code) DO UPDATE SET
  //   shop_name = EXCLUDED.shop_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
  //   coord_source = EXCLUDED.coord_source, service_time_min = EXCLUDED.service_time_min,
  //   open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time;
}

// --- History / Presale (append parsed rows) ---
export async function insertHistoryEntries(records) { /* parameterized INSERT */ }
export async function insertPresaleEntries(records)  { /* parameterized INSERT */ }

// --- Cross-workbook joins on Customer_Code (Requirement 2.5) ---
// Master wins for coords/service/working time via SQL JOIN + column selection.
// The joins return the full joined set; the (pure) filter functions in the
// services narrow the result so filter logic stays DB-independent and property-testable.
// joinPresale() -> Array<{ presale, shop }>
//   SELECT p.*, s.lat, s.lng, s.service_time_min, s.open_time, s.close_time, s.coord_source
//   FROM presale_entries p LEFT JOIN shops s ON s.customer_code = p.customer_code;
export async function joinPresale() { /* ... */ }
// joinHistory() -> Array<{ history, shop }>
//   SELECT h.*, s.lat, s.lng, s.service_time_min, s.open_time, s.close_time
//   FROM history_entries h LEFT JOIN shops s ON s.customer_code = h.customer_code;
export async function joinHistory() { /* ... */ }

// --- Test isolation ---
// truncateAll() -> TRUNCATE shops, history_entries, presale_entries,
//                  drivers, driver_sessions RESTART IDENTITY CASCADE;
export async function truncateAll() { /* ... */ }
```

**`db/schema.sql` — table definitions**

```sql
CREATE TABLE IF NOT EXISTS shops (
  customer_code    TEXT PRIMARY KEY,
  shop_name        TEXT,
  lat              DOUBLE PRECISION,          -- NULL when unresolved
  lng              DOUBLE PRECISION,          -- NULL when unresolved
  coord_source     TEXT NOT NULL,             -- 'master' | 'longdo' | 'unresolved'
  service_time_min INTEGER,                   -- Session_Duration
  open_time        TEXT,                      -- Working_Time start, e.g. '08:00'
  close_time       TEXT                       -- Working_Time end,   e.g. '17:00'
);

CREATE TABLE IF NOT EXISTS history_entries (
  id            BIGSERIAL PRIMARY KEY,
  customer_code TEXT NOT NULL,
  customer_name TEXT,
  dc_name       TEXT,
  store_name    TEXT,
  invoice_date  DATE,                         -- delivered date (DELIVERY_DATE range filter)
  time_visit    TIMESTAMP,                    -- ordering key (Req 3.1)
  visit_type    TEXT,
  store_group   TEXT,
  store_area    TEXT,
  customer_type TEXT,
  quantity      INTEGER                       -- จำนวนลง
);
CREATE INDEX IF NOT EXISTS idx_history_customer_code ON history_entries (customer_code);

CREATE TABLE IF NOT EXISTS presale_entries (
  id            BIGSERIAL PRIMARY KEY,
  customer_code TEXT,                         -- parsed prefix of CustomerName (Req 5.1)
  customer_name TEXT,
  delivery_date DATE,
  demand        INTEGER                       -- จำนวน Presale
);
CREATE INDEX IF NOT EXISTS idx_presale_customer_code ON presale_entries (customer_code);

-- Driver auth (Requirement 10)
CREATE TABLE IF NOT EXISTS drivers (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                -- 'scrypt$<saltHex>$<hashHex>' — never plaintext
  route_id      TEXT                          -- assigned route reference
);

CREATE TABLE IF NOT EXISTS driver_sessions (
  token      TEXT PRIMARY KEY,                -- opaque random bearer token
  driver_id  BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_driver_id ON driver_sessions (driver_id);
```

**Data-layer tradeoff (stated explicitly):** PostgreSQL is chosen so that uploaded workbook data, driver credentials, and sessions are **durable and shareable across instances** — the same records survive process restarts and can be read by multiple app processes. The cost is that the system now **requires a running Postgres instance** (configured via env vars) rather than being fully self-contained. Records are keyed on `Customer_Code`, and the repository interface is kept small (upserts, inserts, join queries) so services depend only on those functions and can be tested with injected fakes.

**Join key (Requirement 2.5):** `History.Customer_Code`, `ShopMaster.Customer_code`, and the parsed code prefix from `Presale.CustomerName` all normalise to a trimmed string stored as `customer_code`. The join is performed in SQL (`LEFT JOIN shops s ON s.customer_code = ...`); when a code exists in both Presale/History and the Shop_Master, the `SELECT` takes coordinates, `service_time_min` (Session_Duration), and `open_time`/`close_time` (Working_Time) from the `shops` (master) columns, so master data wins.

### ETA service extension — `services/etaService.js`

Extended **backward-compatibly**. The existing `computeETAs` and `etasFromLegs` signatures keep working; a new options argument adds per-stop service time and window flags.

```js
// etasFromLegs(stops, legs, departAt, options?) where options = {
//   serviceMinutesFor: (stop) => number | undefined,  // default: SERVICE_MINUTES_PER_STOP
//   flagWindows: boolean
// }
// Each result entry gains (when flagWindows):
//   { ..., serviceMin, windowViolation: boolean, windowReason?: string }
//
// Per-stop service time (Requirement 7.2, 7.3):
//   serviceMin = stop.serviceTimeMin ?? SERVICE_MINUTES_PER_STOP
// Time-window flag (Requirement 7.1):
//   violation = stop has open/close AND eta-clock-time is outside [open, close]
```

`open_time`/`close_time` are wall-clock times (e.g. `"08:00"`). The check compares the ETA's local time-of-day against the window. When a stop has no window, `windowViolation` is `false`.

### History comparison — `services/historyService.js`

```js
// compareHistory({ filters, depot?, vehicle?, departAt? }) -> HistoryComparison
// Steps:
//   1. joined  = await repositories.joinHistory()        (SQL JOIN on Customer_Code)
//      records = applyHistoryFilters(joined, filters)     (pure filter, Req 4)
//   2. guard counts: 0 -> {message:"no records selected"} (Req 3.7)
//                     1 -> {message:"needs >= 2 customers"} (Req 3.6)
//                     filtered-to-empty -> {message:"no records matched"} (Req 4.4)
//   3. historicalOrder = records sorted asc by TIME_VISIT (Req 3.1)
//   4. optimizedOrder  = solveCVRP(single vehicle, same customers) (Req 3.2)
//   5. historicalETAs / optimizedETAs via routeService legs + etaService (Req 3.3)
//   6. per-customer rows: { customerCode, customer, historicalSeq, optimizedSeq,
//                           historicalEta, optimizedEta } (Req 3.4)
//   7. totals: historicalDistanceKm, optimizedDistanceKm (Req 3.5)
```

A single notional vehicle (default speed, capacity large enough for the set) is used for both orders so the comparison isolates **stop ordering** rather than fleet packing.

### Presale plan — `services/presaleService.js`

```js
// buildPresalePlan({ filters, depot?, vehicles?, departAt? }) -> PresalePlan
// Steps:
//   1. joined = await repositories.joinPresale()  (SQL JOIN on Customer_Code)  (Req 5.1)
//   2. filtered = applyPresaleFilters(joined, filters)               (Req 6)
//        empty -> {message:"no customers matched"} (Req 6.3)
//   3. Split into:
//        orders     = joined rows WITH resolved coordinates ->
//                     { id, customer, demand: จำนวน Presale, location,
//                       serviceTimeMin, openTime, closeTime, address }
//        unassigned = rows WITHOUT coordinates, with reason (Req 5.5)
//   4. plan = planDeliveries({ depot, vehicles, orders, departAt }) (Req 5.2, 5.3)
//        with ETA options: serviceMinutesFor + flagWindows (Req 7)
//   5. return { plan, unassigned, windowViolations }
```

Demand is `จำนวน Presale` (Requirement 5.1). `service_time_min` from the joined Shop_Master becomes the per-stop service time (Requirement 5.4, 7.2).

### Driver authentication & route — `auth/credentials.js` + `services/driverService.js`

```js
// auth/credentials.js  (pure crypto — no DB, so it stays property-testable)
// hashPassword(plain) -> "scrypt$<saltHex>$<hashHex>"     (node:crypto scrypt)
// verifyPassword(plain, stored) -> boolean                (timing-safe compare)
// newToken() -> string    (random 32-byte hex bearer token)

// db/repositories.js  (persistence for auth)
// findDriverByUsername(username) -> { id, username, passwordHash, routeId } | null
// insertSession(token, driverId, expiresAt?) -> void   (INSERT INTO driver_sessions ...)
// findSession(token) -> { driverId, expiresAt } | null (SELECT ... WHERE token = $1)
// deleteSession(token) -> void                         (logout / expiry cleanup)

// services/driverService.js
// login(username, password) -> { token, driverId } | throws AuthError (Req 10.1, 10.2)
//   1. driver = await repositories.findDriverByUsername(username)
//   2. verifyPassword(password, driver.passwordHash)  (timing-safe)
//   3. token = newToken(); await repositories.insertSession(token, driver.id)
// getDriverRoute(token) -> { route } | throws AuthError when token invalid (Req 10.3)
//   resolveToken(token): session = await repositories.findSession(token)
//                        -> session.driverId when present and unexpired, else null
// advanceStop(route, completedSeq) -> route'  (current -> next uncompleted) (Req 8.3)
```

**Security choices (stated explicitly):**
- Passwords are **hashed with `scrypt`** (Node's built-in `crypto.scryptSync`) with a per-user random salt — **never stored in plaintext**. Verification uses `crypto.timingSafeEqual`. Hashing/verification lives in `auth/credentials.js` as pure functions.
- Sessions use an **opaque random bearer token** persisted in the `driver_sessions` table (`token` PK → `driver_id`, with `created_at`/`expires_at`). Because sessions live in Postgres, **tokens survive restarts and are shared across instances**. `resolveToken` queries `driver_sessions` and treats an absent or expired row as unauthenticated.
- Driver credentials live in the `drivers` table (`id`, `username` UNIQUE, `password_hash`, assigned `route_id`). **No plaintext passwords are committed**: a seeding script (`db/seedDrivers.js`) inserts each driver's username together with a `scrypt` hash generated from an env-configured seed value or a local fixture, never a committed plaintext password.
- Invalid credentials return a **generic** "invalid username or password" error that does not reveal which field was wrong (Requirement 10.2).
- While unauthenticated, route endpoints return `401` with **no route/stop data** (Requirement 10.3).

**Driver → route assignment:** the `drivers.route_id` column links each driver to a `route_id`. When a presale/history plan is generated it can be assigned to a driver by updating that column; `getDriverRoute` resolves the driver's assigned `route_id` and returns its stops. Because the assignment is persisted, it survives restarts.

### Driver view — `public/driver.html` + `driver.js`

- Mobile-first single-column layout (`meta viewport`, CSS max-width, large tap targets) (Requirement 8.2).
- Login form → `POST /api/driver/login`; token held in memory (and `sessionStorage`) (Requirement 10).
- Renders the single assigned route: ordered stops with customer name + ETA, current stop highlighted (Requirement 8.1).
- "Mark complete" advances the highlighted current stop to the next uncompleted stop (Requirement 8.3).
- Each stop shows a **Google Maps link**:
  - coords → `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>` (Requirement 9.1)
  - address only → `...&destination=<url-encoded address>` (Requirement 9.2)
  - opens in a new tab/context (`target="_blank" rel="noopener"`) (Requirement 9.3)
  - if no link can be built, the raw coords/address are shown as fallback text (Requirement 9.4)
- Empty plan → shows exactly a "no stops to deliver" message, only when there are zero stops (Requirement 8.4); if even that render fails, a fallback "plan could not be loaded" message is shown (Requirement 8.5).

### New API endpoints

| Method | Path | Request | Response (200) |
| --- | --- | --- | --- |
| POST | `/api/ingest/upload` | `multipart/form-data`: `file` (xlsx), optional `type` hint | `{ type, rowCount, headers[], mapped, warnings[] }` |
| POST | `/api/history/compare` | `{ filters: { DC_Name?, StoreName?, StoreGroup?, "Store Area"?, CustomerType?, deliveryDateFrom?, deliveryDateTo? } }` | `{ customers[], historicalDistanceKm, optimizedDistanceKm }` or `{ message }` |
| POST | `/api/presale/plan` | `{ filters?, depot?, vehicles?, departAt? }` | `{ plan, unassigned[], windowViolations[] }` or `{ message }` |
| POST | `/api/driver/login` | `{ username, password }` | `{ token, driverId }` (401 on failure) |
| GET | `/api/driver/route` | header `Authorization: Bearer <token>` | `{ route: { stops[...] } }` (401 when unauthenticated) |

Error responses use the existing convention `{ error: "<message>" }` with a `4xx` status; unexpected errors fall through to the central handler in `server.js` (`500`).

**Upload error shapes:** unreadable file → `400 { error: "File is not a readable .xlsx workbook" }` (Requirement 1.3); missing required columns → `400 { error: "Missing required columns: <a>, <b>" }` (Requirement 1.4).

## Data Models

```js
// ShopRecord (from Shop_Master, Requirement 1.8, 2)
{
  customerCode: "12345",
  shopName: "ร้านสมชาย",
  location: { lat: 13.72, lng: 100.53 } | null,   // resolved (Req 2)
  coordSource: "master" | "longdo" | "unresolved",
  serviceTimeMin: 10,        // Session_Duration
  openTime: "08:00",         // Working_Time start
  closeTime: "17:00",        // Working_Time end
}

// HistoryEntry (from History_Workbook, Requirement 1, 3, 4)
{
  customerCode: "12345",
  customerName: "ร้านสมชาย",
  dcName: "DC Bangkok",
  storeName: "SALES-01",
  invoiceDate: "2026-01-10",   // delivered date (for DELIVERY_DATE range filter)
  timeVisit: "2026-01-10T09:15:00",  // ordering key (Req 3.1)
  visitType: "M1",
  storeGroup: "MT",
  storeArea: "Central",
  customerType: "KA",
  quantity: 12,                // จำนวนลง
}

// PresaleEntry (from Presale_Workbook, Requirement 5, 6)
{
  customerCode: "12345",       // parsed prefix of CustomerName (Req 5.1)
  customerName: "ร้านสมชาย",
  deliveryDate: "2026-02-01",
  demand: 20,                  // จำนวน Presale
}

// Order (existing shape, consumed by optimizer — unchanged core + optional fields)
{
  id: "12345", customer: "ร้านสมชาย", demand: 20,
  location: { lat, lng },
  serviceTimeMin?: 10, openTime?: "08:00", closeTime?: "17:00", address?: "..."
}

// HistoryComparison
{
  customers: [
    { customerCode, customer, historicalSeq, optimizedSeq, historicalEta, optimizedEta }
  ],
  historicalDistanceKm, optimizedDistanceKm
}

// PresalePlan
{
  plan: <planDeliveries output, stops carry windowViolation>,
  unassigned: [ { customerCode, customer, reason } ],
  windowViolations: [ { customerCode, eta, openTime, closeTime } ]
}

// DriverRoute
{
  driverId, routeId,
  stops: [ { sequence, customerCode, customer, eta, location|null, address|null,
             completed: boolean, mapsUrl } ],
  currentSequence: number
}
```

### Filter model

```js
// History filters (Requirement 4)
{ DC_Name?, StoreName?, StoreGroup?, "Store Area"?, CustomerType?,   // exact-match, all must match
  deliveryDateFrom?, deliveryDateTo? }                               // inclusive range on invoiceDate
// Presale filters (Requirement 6) — drawn from presale row or joined master/history
{ DC_Name?, StoreName?, DELIVERY_DATE?, StoreGroup?, "Store Area"?, CustomerType? }
```

An absent/empty criterion is ignored (matches everything). When all supplied criteria match nothing, the capability returns a "no records/customers matched" message.

### Sequence flows

```mermaid
sequenceDiagram
  participant U as Planner
  participant API
  participant ING as Ingestion
  participant REPO as Repositories
  participant PG as PostgreSQL
  U->>API: POST /api/ingest/upload (xlsx)
  API->>ING: parseWorkbook + classify + validate
  alt unreadable / missing columns
    ING-->>API: IngestionError
    API-->>U: 400 { error }
  else valid
    ING->>ING: map rows (+resolve coords, collect warnings)
    ING->>REPO: upsertShops / insertHistory / insertPresale
    REPO->>PG: parameterized INSERT ... ON CONFLICT
    alt DB connection / query error
      PG-->>REPO: error
      REPO-->>API: throws -> central handler
      API-->>U: 500 { error }
    else stored
      ING-->>API: { rowCount, headers, warnings }
      API-->>U: 200
    end
  end
```

```mermaid
sequenceDiagram
  participant U as Manager
  participant API
  participant H as historyService
  participant REPO as Repositories
  participant PG as PostgreSQL
  participant O as optimizer/ETA
  U->>API: POST /api/history/compare { filters }
  API->>H: compareHistory(filters)
  H->>REPO: joinHistory()
  REPO->>PG: SELECT ... history_entries JOIN shops
  PG-->>REPO: joined rows
  REPO-->>H: joined rows
  H->>H: applyHistoryFilters (pure)
  alt 0 / 1 / no-match
    H-->>API: { message }
  else >= 2 customers
    H->>H: historical order by TIME_VISIT
    H->>O: optimize + ETA (both orders)
    H-->>API: { customers[], distances }
  end
  API-->>U: 200
```

```mermaid
sequenceDiagram
  participant D as Driver
  participant API
  participant DS as driverService
  participant REPO as Repositories
  participant PG as PostgreSQL
  D->>API: POST /api/driver/login { username, password }
  API->>DS: login(username, password)
  DS->>REPO: findDriverByUsername
  REPO->>PG: SELECT ... FROM drivers WHERE username = $1
  PG-->>REPO: driver row | none
  REPO-->>DS: driver | null
  alt invalid (unknown user or bad password)
    DS-->>API: AuthError
    API-->>D: 401 { error: "invalid username or password" }
  else valid
    DS->>REPO: insertSession(token, driverId)
    REPO->>PG: INSERT INTO driver_sessions ...
    DS-->>API: { token, driverId }
    API-->>D: 200 token
    D->>API: GET /api/driver/route (Bearer token)
    API->>DS: resolveToken(token)
    DS->>REPO: findSession(token)
    REPO->>PG: SELECT ... FROM driver_sessions WHERE token = $1
    PG-->>REPO: session | none
    DS-->>API: route (stops, ETA, mapsUrl) | AuthError
    API-->>D: 200 | 401
  end
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Property-based testing **is appropriate** for this feature: the ingestion, coordinate-resolution, join-selection, filter, ordering, ETA, link-generation, and credential layers are pure functions (or easily made pure with stubbed I/O) with universal properties over large input spaces. The Longdo geocoder, the ExcelJS reader, and the PostgreSQL repository layer are external I/O and are exercised with example/integration tests and injected fakes/stubs rather than property tests — property tests never require a live database. The join **precedence** logic (master-wins column selection, Property 5) is validated as a pure function over joined-row inputs produced by a repository fake. UI look-and-feel criteria (8.2) and defensive fault-injection branches (1.7, 8.5, 9.3) are covered by example tests.

### Property 1: Parse preserves headers and row count

*For any* grid of header names and data rows written to an in-memory workbook, parsing that workbook SHALL return `headers` equal to the input headers and `rowCount` equal to the number of data rows.

**Validates: Requirements 1.2**

### Property 2: Missing required columns are rejected and named

*For any* workbook type and *any* non-empty subset of that type's required columns removed from the header set, column validation SHALL return `ok: false` with `missing` equal to exactly the removed required columns.

**Validates: Requirements 1.4**

### Property 3: Row mapping excludes invalid rows, conserves the rest, and yields well-formed records

*For any* set of source rows where an arbitrary subset has blanks in required columns, the mapper SHALL exclude exactly the blanked rows (recording each excluded row number in warnings), map every remaining row, so that `mapped.length + excluded.length` equals the total row count, and every mapped Shop_Master record SHALL expose a shop identifier, a coordinates field, a Session_Duration, and a Working_Time.

**Validates: Requirements 1.5, 1.6, 1.8**

### Property 4: Coordinate resolution follows precedence and excludes unusable coordinates

*For any* shop, `resolveShopCoordinates` SHALL use the Shop_Master numeric `lat`/`long` when present and not `(0,0)`; otherwise resolve via the geocoder; and *for any* shop whose only available coordinates are missing, non-numeric, or `(0,0)`, the shop SHALL be marked unresolved, excluded from routable orders, and recorded in warnings by identifier.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

### Property 5: Master data wins on cross-workbook join

*For any* `Customer_Code` present in both the Presale (or History) data and the Shop_Master, the joined record SHALL take its coordinates, `service_time_min`, `open_time`, and `close_time` from the Shop_Master.

**Validates: Requirements 2.5**

### Property 6: Historical order is the timestamp ordering

*For any* set of selected History records, the derived historical order SHALL be a permutation of that set that is non-decreasing by `TIME_VISIT`.

**Validates: Requirements 3.1**

### Property 7: History comparison covers the full customer set in both orderings

*For any* selection of at least two resolvable customers, the optimized order SHALL contain exactly the same customer set as the historical order, and the comparison SHALL report for every customer a historical sequence position, an optimized sequence position, a historical ETA, and an optimized ETA.

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 8: Reported comparison distances equal the route distances of each ordering

*For any* history comparison, `historicalDistanceKm` SHALL equal the route distance of the historical ordering and `optimizedDistanceKm` SHALL equal the route distance of the optimized ordering (depot → stops → depot).

**Validates: Requirements 3.5**

### Property 9: History filtering is sound and empty-filter is identity

*For any* set of History records and *any* combination of the exact-match criteria (`DC_Name`, `StoreName`, `StoreGroup`, `Store Area`, `CustomerType`) and an optional inclusive `DELIVERY_DATE` range, every returned record SHALL satisfy every supplied criterion and fall within the supplied date range; and when no criteria are supplied, all records SHALL be returned.

**Validates: Requirements 4.1, 4.2, 4.3**

### Property 10: Presale code parsing round-trips and produces well-formed orders

*For any* `Customer_Code` and customer name, parsing the concatenated `CustomerName` SHALL recover the original `Customer_Code`; and *for any* resolvable joined presale entry, the produced order SHALL have the `{ id, customer, demand, location:{lat,lng} }` shape with `demand` equal to `จำนวน Presale`.

**Validates: Requirements 5.1**

### Property 11: Presale routing respects vehicle capacity

*For any* set of presale orders and *any* fleet, every produced route's total load SHALL be less than or equal to its vehicle's capacity.

**Validates: Requirements 5.2**

### Property 12: Every assigned presale stop has an ETA

*For any* presale plan, every stop assigned to a route SHALL have a non-null estimated delivery time.

**Validates: Requirements 5.3**

### Property 13: Unresolvable presale customers are unassigned with a reason and never routed

*For any* presale customer that cannot be matched to coordinates, that customer SHALL appear in the unassigned list with a reason and SHALL NOT appear as a routed stop, regardless of whether Shop_Master data exists for it.

**Validates: Requirements 5.5**

### Property 14: Presale filtering is sound and empty-filter is identity

*For any* set of joined presale customers and *any* combination of the criteria (`DC_Name`, `StoreName`, `DELIVERY_DATE`, `StoreGroup`, `Store Area`, `CustomerType`), every included customer SHALL satisfy every supplied criterion; and when no criteria are supplied, all presale customers SHALL be included.

**Validates: Requirements 6.1, 6.2**

### Property 15: Per-stop service time is applied, defaulting when absent

*For any* sequence of stops, the service time added to the cumulative clock after arriving at a stop SHALL equal that stop's `service_time_min` when defined, and SHALL equal the existing default service time when it is not defined.

**Validates: Requirements 5.4, 7.2, 7.3**

### Property 16: Time-window violation flag is exact

*For any* stop that defines an `open_time`/`close_time` window and *any* computed ETA, the stop SHALL be flagged as a time-window violation if and only if the ETA's time-of-day falls outside the inclusive `[open_time, close_time]` window.

**Validates: Requirements 7.1**

### Property 17: Driver view renders stops in optimized sequence with name and ETA

*For any* assigned route, the rendered stop list SHALL be ordered by non-decreasing sequence position and each rendered stop SHALL include its customer name and estimated delivery time.

**Validates: Requirements 8.1**

### Property 18: Completing the current stop advances to the next uncompleted stop

*For any* route and *any* stop marked completed, `advanceStop` SHALL set the current stop to the first uncompleted stop after it in sequence order, or to a completed state when none remain.

**Validates: Requirements 8.3**

### Property 19: The empty-plan message appears exactly when there are no stops

*For any* plan, the Driver_View SHALL display the "no stops to deliver" message if and only if the plan contains zero stops.

**Validates: Requirements 8.4**

### Property 20: Google Maps link targets coordinates, then address, else falls back

*For any* stop with coordinates, the generated Google Maps link's destination SHALL equal `"lat,lng"`; *for any* stop with an address but no coordinates, the destination SHALL equal the URL-encoded address; and *for any* stop with neither, link generation SHALL return no URL so the view shows the coordinates or address as fallback text.

**Validates: Requirements 9.1, 9.2, 9.4**

### Property 21: Password hashing round-trips and valid login issues a resolvable token

*For any* password string, verifying that password against its own hash SHALL succeed, and logging in with a seeded driver's correct credentials SHALL issue a token that resolves to that driver's identifier.

**Validates: Requirements 10.1**

### Property 22: Invalid credentials are denied with a single generic error

*For any* password that differs from a driver's real password, and *for any* unknown username, authentication SHALL fail with an identical generic error that does not reveal which field was incorrect.

**Validates: Requirements 10.2**

### Property 23: Unauthenticated requests receive no route data

*For any* string that is not a currently valid issued token (including an absent token), retrieving the driver route SHALL deny access and return no route or stop information.

**Validates: Requirements 10.3**

## Error Handling

| Condition | Where | Handling | Requirement |
| --- | --- | --- | --- |
| Non-`.xlsx` / corrupt buffer | `excelParser` | Throw `IngestionError`; route returns `400 { error: descriptive }` | 1.3 |
| Missing required columns | `schema.validateColumns` | Route returns `400` naming each missing column | 1.4 |
| Row missing required value | `mappers` | Exclude row, push warning `{ row, reason }`, continue | 1.5, 1.6 |
| Warning sink throws | `mappers` | Wrap warning push in try/catch; continue mapping | 1.7 |
| Coordinates unresolved / `(0,0)` | `geocoder` | Exclude from routing, push warning by id | 2.3, 2.4 |
| Geocoder network/HTTP error | `LongdoGeocoder` | Treat as unresolved (return null), warn; never crash the plan | 2.2, 2.3 |
| 0 / 1 selected customers | `historyService` | Return `{ message }` (not an error) | 3.6, 3.7 |
| Filter matches nothing | history/presale services | Return `{ message }` | 4.4, 6.3 |
| Presale customer without coords | `presaleService` | List as unassigned with reason | 5.5 |
| Invalid driver credentials | `driverService` | `401 { error: "invalid username or password" }` (generic) | 10.2 |
| Missing/invalid bearer token | `driverRoutes` | `401`, no route body | 10.3 |
| Empty-plan message render fails | `driver.js` | Catch and show fallback "plan could not be loaded" | 8.5 |
| Maps link cannot be built | `driver.js` | Show coords/address as plain fallback text | 9.4 |
| DB query error (constraint, syntax, timeout) mid-request | `db/repositories.js` | Let the rejected promise propagate; route/`async` handler forwards to the central handler → `500 { error }` | — |
| DB connection lost during a request | `db/pool.js` (via `pg` Pool) | Pool surfaces the error; repository call rejects and is surfaced via the central error handler as `500` | — |
| Postgres unreachable at startup | `db/pool.js` bootstrap | Verify connectivity on boot (a `SELECT 1` health check); log a clear message and exit non-zero rather than serving requests against a dead DB | — |
| Unexpected error | `server.js` central handler | `500 { error }` (existing behaviour) | — |

`IngestionError` and `AuthError` are small `Error` subclasses carrying an HTTP status so routes can translate them consistently. Route handlers that call `async` repository functions wrap their bodies (or use an async wrapper) so rejected DB promises reach the central error handler instead of crashing the process. Uploaded values reach Postgres only through **parameterized queries**, so untrusted cell content is treated as data and cannot alter SQL; file size is bounded by a multer limit to avoid memory exhaustion.

## Testing Strategy

Testing uses the existing `node:test` runner (`npm test`, `node --test`) with `node:assert/strict`, matching the current `tests/` setup and ES-module style.

### Property-based testing

- **Library**: add [`fast-check`](https://www.npmjs.com/package/fast-check) (pin `fast-check@^3`) — the standard property-based testing library for JavaScript/TypeScript. It integrates with `node:test` via `fc.assert(fc.property(...))`. Property tests are **not** implemented from scratch.
- **Iterations**: each property test runs a **minimum of 100 iterations** (fast-check's `numRuns: 100` or higher).
- **Tagging**: each property test is annotated with a comment in the form
  `// Feature: excel-route-planning, Property {number}: {property text}`
  and cites the requirement clause it validates.
- **Coverage**: one property-based test per correctness property (Properties 1–23). Generators build workbook grids, shop/history/presale records (including Thai strings, blank cells, `(0,0)` and non-numeric coords), filter criteria, routes, and passwords. External I/O (Longdo geocoder, ExcelJS network-free file load, and the **PostgreSQL repository layer**) is stubbed or replaced with **injected repository fakes** so property tests stay pure, fast, and deterministic. **Property tests never require a running database** — the pure logic under test (mappers, coordinate precedence, join master-wins selection, filters, ordering, ETA, maps-url generation, credential hashing/verification, token resolution) receives in-memory data from fakes.

### Unit and example tests

- Parsing a fixture workbook (1.1), unreadable-buffer rejection (1.3), warning-sink failure (1.7).
- Boundary messages: 0/1 customer (3.6, 3.7), no-match filters (4.4, 6.3).
- Driver view render specifics: empty-message fallback (8.5), anchor `target=_blank rel=noopener` (9.3), viewport/max-width presence (8.2).

### Integration tests (against a real test PostgreSQL)

These tests exercise the actual `pg` repository layer and SQL and therefore **require a test database**. They connect via a `DATABASE_URL` pointing at a disposable schema/database (e.g. a local or CI Postgres, ideally a throwaway container), apply `db/schema.sql` once, and **truncate/reset all tables between tests** (`truncateAll()` → `TRUNCATE ... RESTART IDENTITY CASCADE`) for isolation. Tests are skipped with a clear message when `DATABASE_URL` is not configured, so the pure unit/property suite still runs without a database.

- Repository round-trips: `upsertShops` then `joinPresale`/`joinHistory` return the stored rows; a second `upsertShops` with the same `customer_code` **updates rather than duplicates** (verifies `ON CONFLICT` upsert).
- Cross-workbook join in SQL: seeded shops + presale/history rows produce joined rows where master columns win (Requirement 2.5).
- `/api/ingest/upload` with a real multipart request and an in-memory fixture workbook → asserts rows persisted in Postgres, counts, warnings.
- End-to-end `/api/presale/plan` and `/api/history/compare` against seeded database rows (1–2 representative cases).
- Driver flow against the DB: seed a driver (via `db/seedDrivers.js`), `login` → session row persisted → `route` happy path; `401` without token and with an unknown token; token resolves after a simulated restart (new pool) to confirm session durability.
- Longdo geocoder: a single stubbed-`fetch` example verifying request shape and response parsing (not property-tested — external service).

### Regression safety

The existing `tests/optimizer.test.js` suite MUST continue to pass **unchanged**, confirming the ETA extension and new order fields do not alter existing sample-flow behaviour. It exercises only the optimizer/ETA core and does not touch Postgres, so it runs without a database.

## Requirements coverage

| Requirement | Design elements |
| --- | --- |
| **1. Upload & parse three workbooks** | `excelParser.js` (1.1), `schema.js` classification + `validateColumns` (1.2–1.4), `mappers.js` exclusion/warnings/continue (1.5–1.7), Shop_Master mapping to ShopRecord (1.8); `POST /api/ingest/upload` via multer memory storage. Properties 1–3. |
| **2. Resolve shop coordinates** | `routing/geocoder.js` + `resolveShopCoordinates` precedence and `(0,0)`/unresolved handling (2.1–2.4); `repositories.joinPresale`/`joinHistory` SQL `JOIN` with master-wins column selection (2.5). Properties 4–5. |
| **3. History comparison** | `historyService.compareHistory`: TIME_VISIT ordering (3.1), optimizer for same set (3.2), dual ETA (3.3), per-customer rows (3.4), totals (3.5), count-guard messages (3.6, 3.7); `POST /api/history/compare`. Properties 6–8. |
| **4. Filter history** | `applyHistoryFilters` exact-match + inclusive date range + identity + no-match message (4.1–4.4). Property 9. |
| **5. Presale plan** | `presaleService.buildPresalePlan` + `customerCode.parseCustomerCode` + `joinPresale`: order shape/demand (5.1), capacity via `solveCVRP` (5.2), ETA (5.3), master service time (5.4), unassigned with reason (5.5); `POST /api/presale/plan`. Properties 10–13, 15. |
| **6. Filter presale** | `applyPresaleFilters` over joined data + identity + no-match message (6.1–6.3). Property 14. |
| **7. Working time & session duration** | Extended `etaService` per-stop service time + default (7.2, 7.3) and time-window flagging (7.1). Properties 15–16. |
| **8. Driver view** | `public/driver.html`/`driver.js` mobile layout (8.2), assigned-route render in sequence with name+ETA (8.1), `advanceStop` (8.3), empty-plan message (8.4), fallback (8.5); `driverService`. Properties 17–19. |
| **9. Google Maps handoff** | `buildMapsUrl` coords/address/fallback (9.1, 9.2, 9.4) and new-context anchor (9.3). Property 20. |
| **10. Driver authentication** | `auth/credentials.js` scrypt hash + token, `drivers` + `driver_sessions` tables (persistent, restart-safe), `driverService.login`/`getDriverRoute` via repositories: valid login (10.1), generic denial (10.2), withhold while unauthenticated (10.3); `POST /api/driver/login`, `GET /api/driver/route`. Properties 21–23. |
