# Implementation Plan: Excel Route Planning

## Overview

This plan extends the existing Farmhouse route-optimization prototype (Express + ES modules, `node:test`) with an Excel ingestion layer, a PostgreSQL data layer, three planning capabilities (history comparison, presale plan, driver app), and driver authentication.

Tasks are ordered so each builds on the last: dependencies first, then the data layer, then pure ingestion/parsing/mapping/geocoding logic, then services, then API routes, then the driver UI, then wiring and end-to-end verification. Pure logic is built and property-tested before the I/O layers that consume it. External I/O (ExcelJS load, Longdo geocoder, the `pg` repository layer) is exercised with example/integration tests; the pure logic is covered by `fast-check` property tests (`numRuns >= 100`, tagged `// Feature: excel-route-planning, Property N: ...`).

The existing optimizer/ETA core is reused unchanged in behaviour; the ETA extension is backward-compatible. Task 15 confirms `tests/optimizer.test.js` still passes unmodified.

## Tasks

- [x] 1. Add and pin dependencies, update scripts and env config
  - Add to `package.json` dependencies: `exceljs@^4.4.0`, `multer@^1.4.5-lts.1`, `pg@^8`; add dev dependency `fast-check@^3`.
  - Keep `type: "module"` and the existing `test` script (`node --test`); add a `db:seed` script that runs `node src/db/seedDrivers.js`.
  - Run the install so `package-lock.json` records the pinned versions.
  - Document the required env vars (`DATABASE_URL` or `PG*`, reuse of `LONGDO_API_KEY`) in code comments where they are read.
  - _Requirements: 1.1, 2.2, 10.1_

- [x] 2. Create the PostgreSQL schema and connection pool
  - [x] 2.1 Write `src/db/schema.sql`
    - Define `shops`, `history_entries`, `presale_entries`, `drivers`, `driver_sessions` tables and indexes exactly as specified in the design Data Layer section (`customer_code` PK on `shops`, `coord_source`, nullable `lat`/`lng`, `service_time_min`, `open_time`, `close_time`; history/presale columns; `drivers.password_hash`/`route_id`; `driver_sessions.token` PK with `expires_at`).
    - _Requirements: 1.8, 2.5, 5.1, 10.1_
  - [x] 2.2 Implement `src/db/pool.js`
    - Build a single shared `pg.Pool` from `DATABASE_URL` or discrete `PG*` env vars (no hard-coded credentials); export `query(text, params)`, `close()`, and an `initSchema()` helper that applies `schema.sql`.
    - Add a boot-time `SELECT 1` health check helper that fails loudly (clear message, non-zero exit) when Postgres is unreachable.
    - _Requirements: 1.8_

- [x] 3. Implement the raw-SQL repository layer
  - [x] 3.1 Implement `src/db/repositories.js` write + join functions
    - Implement `upsertShops(records)` (`INSERT ... ON CONFLICT (customer_code) DO UPDATE`), `insertHistoryEntries(records)`, `insertPresaleEntries(records)`, `joinHistory()` and `joinPresale()` (`LEFT JOIN shops` selecting master coords/`service_time_min`/`open_time`/`close_time`), and `truncateAll()`.
    - Every statement MUST use parameterized queries (`$1, $2, ...`); never concatenate values into SQL.
    - _Requirements: 1.8, 2.5, 3.1, 4.1, 5.1, 6.1_
  - [x] 3.2 Implement `src/db/repositories.js` driver-auth functions
    - Implement `findDriverByUsername(username)`, `insertSession(token, driverId, expiresAt?)`, `findSession(token)`, `deleteSession(token)`, all parameterized.
    - _Requirements: 10.1, 10.2, 10.3_
  - [x] 3.3 Implement `src/db/seedDrivers.js`
    - Seed driver rows with `username` + scrypt `password_hash` (from `auth/credentials.hashPassword`, built in task 8) and assigned `route_id`; read seed values from env/local fixture, never a committed plaintext password.
    - _Requirements: 10.1_
  - [x] 3.4 Write integration tests for the repository layer
    - Require `DATABASE_URL`; skip with a clear message when absent. Apply `schema.sql`, `truncateAll()` between tests.
    - Assert `upsertShops` then `joinPresale`/`joinHistory` round-trips; a repeat `upsertShops` on the same `customer_code` updates (not duplicates); master columns win in the join (Requirement 2.5).
    - _Requirements: 1.8, 2.5_

- [x] 4. Implement Excel parsing (pure over an in-memory buffer)
  - [x] 4.1 Implement `src/ingestion/excelParser.js` and the `IngestionError` type
    - `parseWorkbook(buffer)` loads only the first worksheet via ExcelJS `workbook.xlsx.load(buffer)` and returns `{ headers, rows, rowCount }` with rows keyed by trimmed header text; throw `IngestionError("File is not a readable .xlsx workbook")` when ExcelJS cannot load the buffer.
    - Place `IngestionError` (Error subclass carrying an HTTP status) where routes can import it.
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 4.2 Write property test for parse round-trip
    - **Property 1: Parse preserves headers and row count** — generate header/row grids, write to an in-memory ExcelJS workbook, parse, assert `headers` and `rowCount` match.
    - **Validates: Requirements 1.2**
  - [x] 4.3 Write example test for unreadable buffer
    - Feed a non-xlsx buffer and assert `IngestionError` with a descriptive message.
    - _Requirements: 1.3_

- [x] 5. Implement workbook schema classification and validation
  - [x] 5.1 Implement `src/ingestion/schema.js`
    - Define `WORKBOOK_SCHEMAS` (history / shopMaster / presale required + optional columns per the design), `classifyWorkbook(headers, hint)`, and `validateColumns(type, headers) -> { ok, missing }`.
    - _Requirements: 1.4_
  - [x] 5.2 Write property test for missing-column rejection
    - **Property 2: Missing required columns are rejected and named** — for any type and any non-empty removed subset of its required columns, `validateColumns` returns `ok:false` with `missing` equal to exactly the removed columns.
    - **Validates: Requirements 1.4**

- [x] 6. Implement customer-code parsing and row mappers
  - [x] 6.1 Implement `src/ingestion/customerCode.js`
    - `parseCustomerCode(customerName)` splits the leading code token from the Presale `CustomerName`; returns `{ code, name }` (`code: null` when no leading code).
    - _Requirements: 5.1_
  - [x] 6.2 Implement `src/ingestion/mappers.js`
    - `mapShopMasterRows`, `mapHistoryRows`, `mapPresaleRows`, each returning `{ records, warnings }`; exclude rows blank in a required column, record `{ row, reason, id? }` warnings, wrap the warning push in try/catch and continue, and shape Shop_Master records with identifier, coordinates field, Session_Duration, and Working_Time.
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 5.1_
  - [x] 6.3 Write property test for Presale code parsing round-trip
    - **Property 10 (parsing half): Presale code parsing round-trips** — for any code + name, `parseCustomerCode` of the concatenation recovers the original code. (Order-shape half covered in task 11.)
    - **Validates: Requirements 5.1**
  - [x] 6.4 Write property test for row mapping conservation
    - **Property 3: Row mapping excludes invalid rows, conserves the rest, and yields well-formed records** — for rows with an arbitrary blanked subset, `mapped.length + excluded.length == total`, excluded rows are warned by row number, and each mapped Shop_Master record exposes id, coordinates, Session_Duration, Working_Time.
    - **Validates: Requirements 1.5, 1.6, 1.8**
  - [x] 6.5 Write example test for warning-sink failure
    - Inject a throwing warnings sink and assert mapping still completes the remaining rows.
    - _Requirements: 1.7_

- [x] 7. Implement coordinate resolution in the routing layer
  - [x] 7.1 Implement `src/routing/geocoder.js`
    - `createGeocoder({ apiKey?, baseUrl? })` returning an `EstimatorGeocoder` (returns `null`, no network/key) or a `LongdoGeocoder` (queries the Longdo search endpoint, reuses `LONGDO_API_KEY`, treats network/HTTP errors as unresolved `null`), mirroring the `router.js` provider pattern.
    - `resolveShopCoordinates(shop, geocoder)` applying precedence: numeric `lat`/`long` not `(0,0)` -> `master`; else geocode -> `longdo` when returned and not `(0,0)`; else `{ resolved:false, reason, source:"unresolved" }`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 7.2 Write property test for coordinate-resolution precedence
    - **Property 4: Coordinate resolution follows precedence and excludes unusable coordinates** — use an injected fake geocoder; assert master-first precedence and that missing/non-numeric/`(0,0)` coords are marked unresolved, excluded, and warned by id.
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
  - [x] 7.3 Write example test for the Longdo geocoder request/response
    - Stub `fetch` once; assert request shape (key param) and parsing of a sample response. Not property-tested (external service).
    - _Requirements: 2.2_

- [x] 8. Implement pure credential/token helpers
  - [x] 8.1 Implement `src/auth/credentials.js`
    - `hashPassword(plain) -> "scrypt$<saltHex>$<hashHex>"` (node:crypto scrypt, per-user salt), `verifyPassword(plain, stored)` (timing-safe compare), `newToken()` (32-byte hex); add `AuthError` (Error subclass with HTTP status).
    - _Requirements: 10.1, 10.2_
  - [x] 8.2 Write property test for hashing round-trip
    - **Property 21 (hashing half): Password hashing round-trips** — for any password, `verifyPassword(pw, hashPassword(pw))` is true. (Token-resolution half covered in task 12.)
    - **Validates: Requirements 10.1**
  - [x] 8.3 Write property test for generic denial
    - **Property 22: Invalid credentials are denied with a single generic error** — for any wrong password and any unknown username, verification/login fails with an identical generic error revealing neither field.
    - **Validates: Requirements 10.2**

- [x] 9. Extend the ETA service for per-stop service time and time-window flags
  - [x] 9.1 Extend `src/services/etaService.js`
    - Add a backward-compatible `options` argument to `etasFromLegs(stops, legs, departAt, options?)` with `serviceMinutesFor(stop)` (default `SERVICE_MINUTES_PER_STOP`) and `flagWindows`; when flagging, add `serviceMin`, `windowViolation`, `windowReason` by comparing the ETA time-of-day against `[open_time, close_time]`. Do not change existing signatures/behaviour.
    - _Requirements: 5.4, 7.1, 7.2, 7.3_
  - [x] 9.2 Write property test for per-stop service time
    - **Property 15: Per-stop service time is applied, defaulting when absent** — the service time added after a stop equals its `service_time_min` when defined, else the existing default.
    - **Validates: Requirements 5.4, 7.2, 7.3**
  - [x] 9.3 Write property test for time-window flagging
    - **Property 16: Time-window violation flag is exact** — flagged iff the ETA time-of-day is outside the inclusive `[open_time, close_time]` window.
    - **Validates: Requirements 7.1**

- [x] 10. Implement history comparison service
  - [x] 10.1 Implement `applyHistoryFilters` and `compareHistory` in `src/services/historyService.js`
    - `applyHistoryFilters(joined, filters)` (pure): exact-match on `DC_Name`, `StoreName`, `StoreGroup`, `Store Area`, `CustomerType` plus inclusive `DELIVERY_DATE` range on `invoiceDate`; absent criteria match all.
    - `compareHistory({ filters, depot?, vehicle?, departAt? })`: read `repositories.joinHistory()`, filter, guard 0/1/no-match with messages, derive historical order by non-decreasing `TIME_VISIT`, optimize the same set with a single notional vehicle via `routeService`, compute dual ETAs, emit per-customer rows and historical/optimized total distances.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4_
  - [x] 10.2 Write property test for historical ordering
    - **Property 6: Historical order is the timestamp ordering** — a permutation of the selection, non-decreasing by `TIME_VISIT`.
    - **Validates: Requirements 3.1**
  - [x] 10.3 Write property test for full-set coverage in both orderings
    - **Property 7: History comparison covers the full customer set in both orderings** — optimized set equals historical set; every customer reports both sequence positions and both ETAs. Use an injected repository fake.
    - **Validates: Requirements 3.2, 3.3, 3.4**
  - [x] 10.4 Write property test for reported distances
    - **Property 8: Reported comparison distances equal the route distances of each ordering** — `historicalDistanceKm`/`optimizedDistanceKm` equal depot->stops->depot distance of each ordering.
    - **Validates: Requirements 3.5**
  - [x] 10.5 Write property test for history filtering
    - **Property 9: History filtering is sound and empty-filter is identity** — every returned record satisfies all supplied criteria and the date range; no criteria returns all.
    - **Validates: Requirements 4.1, 4.2, 4.3**
  - [x] 10.6 Write example tests for count/no-match messages
    - 0 customers, 1 customer (3.6, 3.7), and filter-matches-nothing (4.4) return the specified messages.
    - _Requirements: 3.6, 3.7, 4.4_

- [x] 11. Implement presale plan service
  - [x] 11.1 Implement `applyPresaleFilters` and `buildPresalePlan` in `src/services/presaleService.js`
    - `applyPresaleFilters(joined, filters)` (pure): exact-match on `DC_Name`, `StoreName`, `DELIVERY_DATE`, `StoreGroup`, `Store Area`, `CustomerType`; absent criteria match all.
    - `buildPresalePlan({ filters, depot?, vehicles?, departAt? })`: read `repositories.joinPresale()`, filter (no-match message), split into orders WITH coordinates (`{ id, customer, demand: จำนวน Presale, location, serviceTimeMin, openTime, closeTime, address }`) vs unassigned WITHOUT coordinates (with reason), call `planDeliveries` with ETA options (`serviceMinutesFor` + `flagWindows`), and return `{ plan, unassigned, windowViolations }`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 7.1_
  - [x] 11.2 Write property test for order shape / demand
    - **Property 10 (order-shape half): resolvable joined presale entries produce well-formed orders** — order has `{ id, customer, demand, location:{lat,lng} }` with `demand == จำนวน Presale`.
    - **Validates: Requirements 5.1**
  - [x] 11.3 Write property test for capacity
    - **Property 11: Presale routing respects vehicle capacity** — every route's total load `<=` its vehicle capacity.
    - **Validates: Requirements 5.2**
  - [x] 11.4 Write property test for assigned-stop ETA
    - **Property 12: Every assigned presale stop has an ETA** — every routed stop has a non-null ETA.
    - **Validates: Requirements 5.3**
  - [x] 11.5 Write property test for unassigned customers
    - **Property 13: Unresolvable presale customers are unassigned with a reason and never routed** — regardless of Shop_Master presence.
    - **Validates: Requirements 5.5**
  - [x] 11.6 Write property test for presale filtering
    - **Property 14: Presale filtering is sound and empty-filter is identity**.
    - **Validates: Requirements 6.1, 6.2**
  - [x] 11.7 Write example test for no-match message
    - Filter matching no customers returns the "no customers matched" message.
    - _Requirements: 6.3_

- [x] 12. Implement driver service (auth, route, stop advancement)
  - [x] 12.1 Implement `src/services/driverService.js`
    - `login(username, password)` (find driver via repositories, `verifyPassword`, issue + persist token) throwing `AuthError` on any failure; `resolveToken(token)` via `repositories.findSession` (absent/expired -> null); `getDriverRoute(token)` returning the assigned route or throwing `AuthError`; `advanceStop(route, completedSeq)` setting current to the first uncompleted stop after it (or a completed state).
    - _Requirements: 8.3, 10.1, 10.2, 10.3_
  - [x] 12.2 Write property test for valid login token resolution
    - **Property 21 (token half): valid login issues a resolvable token** — a seeded driver's correct credentials issue a token that resolves to that driver's id. Use an injected repository fake.
    - **Validates: Requirements 10.1**
  - [x] 12.3 Write property test for unauthenticated access
    - **Property 23: Unauthenticated requests receive no route data** — any non-valid/absent token denies access and returns no route/stop info.
    - **Validates: Requirements 10.3**
  - [x] 12.4 Write property test for stop advancement
    - **Property 18: Completing the current stop advances to the next uncompleted stop**.
    - **Validates: Requirements 8.3**

- [x] 13. Implement the API routers and wire them into the app
  - [x] 13.1 Implement `src/routes/ingestRoutes.js`
    - `POST /api/ingest/upload` using multer `memoryStorage` (with a file-size limit) on this route only; parse -> classify (optional `type` hint) -> validate columns -> map (+resolve coords) -> persist via repositories; return `{ type, rowCount, headers, mapped, warnings }`; translate `IngestionError` to `400` (unreadable file; missing columns naming each).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4_
  - [x] 13.2 Implement `src/routes/historyRoutes.js` and `src/routes/presaleRoutes.js`
    - `POST /api/history/compare` -> `compareHistory`; `POST /api/presale/plan` -> `buildPresalePlan`; async handlers forward rejected promises to the central error handler.
    - _Requirements: 3.1, 4.1, 5.1, 6.1_
  - [x] 13.3 Implement `src/routes/driverRoutes.js`
    - `POST /api/driver/login` -> `{ token, driverId }` or `401 { error: "invalid username or password" }`; `GET /api/driver/route` reading the `Authorization: Bearer` header -> route or `401` with no body data; each stop carries a `mapsUrl`.
    - _Requirements: 8.1, 9.1, 10.1, 10.2, 10.3_
  - [x] 13.4 Mount the new routers in `src/routes/api.js`
    - Extend the existing router to mount ingest/history/presale/driver sub-routers alongside the existing `/scenario`, `/plan`, `/health` routes without altering them.
    - _Requirements: 1.1, 3.1, 5.1, 8.1, 10.1_
  - [x] 13.5 Serve the driver page and run DB bootstrap in `src/server.js`
    - Ensure `public/driver.html` is served by the existing static handler; run the `pool.js` boot health check on startup; keep the existing central error handler.
    - _Requirements: 8.2_

- [x] 14. Implement the mobile driver view
  - [x] 14.1 Implement `buildMapsUrl` and `public/driver.js` / `driver.html` / `driver.css`
    - `buildMapsUrl(stop)`: coords -> `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`; address only -> `...&destination=<url-encoded address>`; neither -> no URL (view shows coords/address fallback). Links use `target="_blank" rel="noopener"`.
    - Login form -> `POST /api/driver/login` (token in memory/`sessionStorage`); render the single assigned route ordered by sequence with customer name + ETA, current stop highlighted; "Mark complete" advances current stop; empty plan shows exactly the "no stops to deliver" message (only when zero stops); wrap render in try/catch to show a "plan could not be loaded" fallback. Mobile-first layout (`meta viewport`, max-width, large tap targets).
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 10.1, 10.3_
  - [x] 14.2 Write property test for stop rendering
    - **Property 17: Driver view renders stops in optimized sequence with name and ETA** — rendered list is non-decreasing by sequence; each stop includes name + ETA.
    - **Validates: Requirements 8.1**
  - [x] 14.3 Write property test for empty-plan message
    - **Property 19: The empty-plan message appears exactly when there are no stops**.
    - **Validates: Requirements 8.4**
  - [x] 14.4 Write property test for Google Maps link generation
    - **Property 20: Google Maps link targets coordinates, then address, else falls back**.
    - **Validates: Requirements 9.1, 9.2, 9.4**
  - [x] 14.5 Write example tests for driver-view specifics
    - Empty-message render fallback (8.5), anchor `target=_blank rel=noopener` (9.3), viewport/max-width presence (8.2).
    - _Requirements: 8.2, 8.5, 9.3_

- [x] 15. Checkpoint - regression safety
  - Run `npm test` and confirm `tests/optimizer.test.js` passes unchanged (the ETA extension and new optional order fields must not alter existing sample-flow behaviour).
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. End-to-end integration verification (require a test DATABASE_URL)
  - [x] 16.1 Write ingestion + persistence integration test
    - Real multipart `POST /api/ingest/upload` with an in-memory fixture workbook -> rows persisted in Postgres, correct counts and warnings; skip cleanly when `DATABASE_URL` is unset; `truncateAll()` between tests.
    - _Requirements: 1.1, 1.2, 1.4, 2.5_
  - [x] 16.2 Write history/presale endpoint integration tests
    - Seed rows, then 1-2 representative `/api/history/compare` and `/api/presale/plan` requests asserting shapes and messages.
    - _Requirements: 3.4, 5.1, 6.1_
  - [x] 16.3 Write driver-flow integration test
    - Seed a driver via `seedDrivers.js`; `login` persists a session; `route` happy path; `401` without token and with an unknown token; token resolves after a new pool (restart durability).
    - _Requirements: 10.1, 10.3_
  - [x] 16.4 Final checkpoint - ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement clauses and/or design correctness Properties (1-23) for traceability.
- Property tests use `fast-check` (`numRuns >= 100`), tagged `// Feature: excel-route-planning, Property N: ...`, and run against injected fakes/stubs so they never require a live database. Integration tests exercise the real `pg` layer and are skipped when `DATABASE_URL` is absent.
- Checkpoints (tasks 15, 16.4) enforce incremental validation, including the unchanged-regression guarantee for `tests/optimizer.test.js`.
