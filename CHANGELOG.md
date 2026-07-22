# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-07-22

### Added

- **Mockup demo data seed** (`npm run db:seed:demo`): seeds a self-contained
  demo dataset — 15 already-geocoded Bangkok stops (reused from the Sample
  plan scenario) as `shops`/`history_entries`/`presale_entries` under one
  recognizable store, plus a driver account assigned to it — so the delivery
  on-time report, presale planner, and driver map all have realistic data to
  demo without depending on the real dataset's geocoding coverage.
  `time_visit` values are derived from the actual computed optimized ETA
  (the same pipeline the report itself uses) for a correct 5 early / 5
  on-time / 5 late split. Idempotent — safe to re-run.

### Fixed

- **Presale planning's `DELIVERY_DATE` filter silently excluded same-day
  rows.** `presaleService.js`'s `toDateKey()` converted a stored `DATE`
  column's `Date` object via `.toISOString()`, but `node-postgres` builds
  that `Date` from LOCAL calendar components — at a positive UTC offset
  (confirmed live at Bangkok's UTC+7) this rolls the date back by one day,
  so a same-day filter matched zero rows. Mirrors the local-component fix
  `historyService.js` already applies to the identical problem.

## [1.6.0] - 2026-07-22

### Added

- **Real road-following route lines on the dashboard map,** with a numbered
  marker per stop and hover-to-show delivery info (customer, ETA, demand).
  Each route leg draws its actual road geometry — fetched from OSRM's public
  routing server (`router.project-osrm.org`), fully decoupled from Longdo's
  distance/duration call — and falls back to a straight line for any leg
  whose geometry couldn't be fetched, so a single failed leg only degrades
  its own segment. (Longdo's own `route/path`/`geojson/route` endpoints were
  evaluated first but, on live testing, consistently returned geometry that
  never reached the leg's actual destination — an account/key-level
  limitation, not a code bug — so geometry now comes from OSRM instead.)
- **Route preview map on the driver page.** The driver's own route now
  renders on an embedded map — depot, numbered stop markers, and the same
  real/fallback route line as the dashboard — with tap-to-show stop info
  instead of hover, since there's no hover state on a phone.
- **Daily delivery on-time report** (`public/deliveryReport.html`): compares
  each History delivery's actual recorded time against the AI-optimized
  route's computed ETA for that day, reporting an early/on-time/late
  breakdown (±15 min tolerance) both per-store and per-delivery, filterable
  by StoreName/DC_Name/etc.
- **Live driver stop-completion tracking.** `POST /api/driver/complete`
  persists a real completion record (snapshotting the stop's planned ETA
  against the actual completion moment) and returns immediate
  early/on-time/late feedback shown as a badge on the stop; `GET
  /api/driver/route` now reflects persisted completions so they survive a
  refresh. `GET /api/driver/summary` aggregates a driver's own completions
  for the day into a "Today's summary" panel.
- Vehicles now default to departing the depot at 04:00 instead of the exact
  moment a request hits the server, so ETAs reflect a realistic delivery
  start. History comparisons anchor to the filter's selected day and Presale
  plans to the filter's delivery date; an explicit `departAt` still wins.
- A full visual redesign across all 6 pages (`design.md`): a custom OKLCH
  palette anchored on the existing Farmhouse brand hues, Fraunces + Work Sans
  + IBM Plex Mono typography, glassmorphism surfaces over a warm gradient
  backdrop, and a richer motion language (stagger reveal, count-up metrics,
  hover/press feedback, entrance replay on data refresh) — purely additive,
  no route/id/class/form-field the app depends on was touched.

### Fixed

- Geocoding backfill retries were reusing each shop's stale persisted query
  instead of rebuilding it fresh from the current customerName+DC-area
  strategy, so a re-run kept re-attempting an earlier run's query — a real
  run only issued 685 unique queries against 37k customers. Retries now
  rejoin `history_entries` and rebuild the query fresh; the geocoder also
  gained the same request timeout `LongdoRouter` already had, so a bulk
  backfill's thousands of pooled requests can't stall indefinitely on one
  unbounded hang.
- Geocoding queries now combine the cleaned customer name (branch-code noise
  stripped) with the delivery center's area name for disambiguation, instead
  of the internal DC/unit `storeName` code, which was never geocodable.

- **Presale route preview on the dashboard.** A third "Presale" source
  joins History/Sample plan on the dashboard toggle — same endpoint and
  filters as the planner page's "3 · Presale planning" section
  (`POST /api/presale/plan`), so an admin can preview an optimized presale
  route (map, metrics, per-stop sidebar) without leaving the dashboard.
  Each route draws from its own resolved depot (a store's own DC) rather
  than one shared depot. Shaped with the shared, tested `summarizePlan`
  (`planView.js`), extended to carry each stop's `location`/`address`
  through for map plotting — additive, so the planner page's existing
  table view is unaffected.

### Fixed

- **A route with many stops could hang for 90+ seconds instead of
  returning.** `LongdoRouter` (the real-routing provider) computes each
  leg's distance with a real network call; a single unresponsive/rate-limited
  request had no timeout, and — despite the log message implying otherwise —
  every DISTINCT leg still re-attempted Longdo even after an earlier leg had
  already failed. An 11-stop presale route (12 legs) took 90+ seconds in
  production once Longdo started rate-limiting. Fixed with a per-request
  timeout (`requestTimeoutMs`, default 8s, via `AbortController`) and a real
  circuit breaker: after the FIRST failure, every later leg on that router
  skips the network call entirely instead of paying its own failed-request
  cost. The same request now completes in ~5s instead of timing out.
- **Every driver saw every route.** The driver app's route provider

- **Every driver saw every route.** The driver app's route provider
  (`getRouteForDriver` in `routes/driverRoutes.js`) flattened ALL vehicles'
  stops from the most recent presale plan into one list shown to every
  driver, regardless of which store they were assigned to. It now looks up
  the authenticated driver's own assigned store (`drivers.route_id`) and
  returns ONLY the one route whose `vehicleId` matches it — mirroring how
  `presaleService.resolveFleet` builds one vehicle per distinct
  driver-assigned store. A driver with no assignment, or whose store has no
  route in the latest plan, now gets an empty route instead of someone
  else's stops. New `repositories.findDriverById`.

### Added

- **Automatic background processing on upload.** Once all three workbook
  types (Shop_Master, History, Presale) have at least one row, uploading any
  workbook now triggers a background backfill-geocoding job
  (`services/backfillService.js`) — no manual step or filter required. It
  persists a real `shops` row (via the geocoding provider) for every
  customer that appears in History but has no Shop_Master match, and retries
  previously-unresolved shops. Geocoding is deduplicated by QUERY, not by
  customer — most customers share their StoreName as the query, so a real
  dataset's tens of thousands of customer rows collapsed into 685 actual API
  calls. `GET /api/ingest/status` (polled every 2s from the planner page,
  `wireHistoryDayFilter`'s sibling `startBackfillStatusPolling`) shows live
  progress with a progress bar; the poll also runs on page load in case a
  previous upload's job is still in flight.
- **Database viewer page** (`public/database.html`): aggregate summary
  (shop resolution counts, history/presale row + distinct-customer counts,
  DC/store breakdown) plus a paginated raw-row browser for `shops`,
  `history_entries`, and `presale_entries`. New `GET /api/database/summary`
  and `GET /api/database/{shops,history,presale}?page=&pageSize=`.
- **Day-only History filter.** Routes are calculated per store PER DAY, so
  the dashboard and planner's "Date from"/"Date to" range inputs are
  replaced with a single "Day" dropdown that only ever offers days that
  actually have data for the current DC/Store/etc. selection (new
  `GET /api/history/dates`, `repositories.distinctHistoryDates` — same
  cascading-by-active-filters pattern as the categorical dropdowns).
- Dashboard "overview" fallback: when no filter narrows the History
  comparison down to a routable set (the "too many customers" guard), the
  sidebar now shows a breakdown by DC and by StoreName (visit + customer
  counts, busiest first) as two dropdowns instead of just the bare guard
  text. Picking one sets the matching filter and re-runs the comparison, so
  it doubles as a "browse in" shortcut. New `GET /api/history/overview`
  (`repositories.historyOverview`, `historyService.getHistoryOverview`).

### Fixed

- **History date-range filtering silently excluded almost everything for a
  single-day filter, depending on the server's local timezone.** Postgres
  `DATE` columns come back from `pg` as JS `Date` objects built from LOCAL
  time (e.g. `new Date(2026, 6, 17)` for a stored `'2026-07-17'`), but the
  filter compared them against epoch-ms parsed from a plain date string
  (UTC). At UTC+7 this shifted every invoice date by 7 hours, which a wide
  date RANGE mostly absorbed but a single-day filter (`deliveryDateFrom ===
  deliveryDateTo`, exactly what the new Day picker above sends) did not —
  caught live as a 79-customer store's day filter returning zero rows.
  `historyService.js` now compares `"YYYY-MM-DD"` date keys built from the
  Date's LOCAL components instead of raw epoch milliseconds.
- Backfill-geocoding persisted a placeholder `unresolved` shop row's
  `shopName` as the customer's own name instead of the shared query string
  that was actually attempted — which broke the retry pass's dedup-by-query
  on every SUBSEQUENT run (a real run's unique-query count jumped from 685
  to ~37,000). Unresolved rows now persist with `shopName` equal to the
  attempted query, so retries stay deduplicated.
- Backfill-geocoding previously never persisted anything for a customer
  whose geocode attempt failed, which meant `findHistoryOnlyCustomers()`
  would keep returning the SAME tens of thousands of customers on every
  subsequent upload, re-attempting (and re-failing) the same geocode
  queries forever. Failed/unqueryable customers are now persisted with
  `coordSource: 'unresolved'`, so they're picked up by the (already
  deduplicated) unresolved-shops retry path instead of the full scan.
- `compareHistory`'s geocoding fallback (added earlier to resolve customers
  missing from Shop_Master) could make thousands of real, sequential network
  calls to the geocoding provider on an unfiltered request over a large
  dataset — since nearly all rows lacked a Shop_Master match, this hung the
  request instead of returning the "too many customers" guard. Master-only
  resolution now runs first; the (network-bound) geocoding fallback is
  skipped entirely once the master-only count already exceeds
  `MAX_COMPARISON_CUSTOMERS`, since geocoding more rows couldn't change the
  outcome anyway.

### Security

- Added a master admin credential (`admin` / a fixed password) embedded
  directly in `src/services/adminService.js`, at the requester's explicit
  informed insistence after being warned of the tradeoff. It signs in without
  any `admins` database row and its session token is tracked only in-memory
  (never written to `admin_sessions`). Unlike every other password in this
  system, this one is scrypt-hashed but the hash itself is permanently
  visible to anyone with read access to this repository/its git history and
  cannot be rotated without a code change. A real DB-backed `admin` account
  (if one exists) is unaffected and still authenticates with its own
  password — the master credential is only checked first, as an additional
  path.

### Added

- First-run admin setup page (`public/admin.html`): when no admin account
  exists yet, the login page shows a "Create admin account" form instead of
  the sign-in form, so bootstrapping the first admin no longer requires
  running `npm run db:seed:admin` from a terminal. `GET /api/admin/setup-status`
  reports whether setup is needed; `POST /api/admin/setup`
  (`adminService.setupFirstAdmin`) creates the account and signs the caller in
  — deliberately unauthenticated (nobody can hold a token yet) but strictly
  gated by the current admin count, so it can never create a second admin
  once setup has been completed, regardless of who calls it.

## [1.5.0] - 2026-07-21

### Added

- Filter dropdowns (DC_Name, StoreName, StoreGroup, Store Area, CustomerType)
  on the dashboard and planner now cascade with the data's real hierarchy:
  picking a value narrows every OTHER dropdown to only the values that still
  co-occur with the current selection (e.g. choosing a DC narrows StoreName to
  that DC's own stores), instead of always listing every distinct value in the
  dataset. `GET /api/filters` accepts the current selection as query
  parameters and `distinctHistoryFilterValues` scopes each column's query by
  every other active filter server-side; `filterOptions.js`'s new
  `wireCascadingFilters` refetches and repopulates the form on every select
  change.
- Filter dropdowns now use the app's glass theme: frosted-glass closed
  control with a custom chevron and warm-toned option list, matching the
  rest of the UI (native `<select>` popups can't take a backdrop blur
  themselves, so the open list gets matching colors instead).

### Fixed

- Integration tests now read a separate `TEST_DATABASE_URL` instead of
  `DATABASE_URL` (see `tests/helpers/dbIntegration.js`). Every integration
  test truncates all tables between cases for isolation; reading the same
  `DATABASE_URL` used to run the app meant running `npm test` in any
  shell/editor/git-hook where that variable pointed at a real database would
  silently wipe it. Decoupling the variable closes this regardless of what
  `DATABASE_URL` is set to.
- Presale planning (`buildPresalePlan`) no longer hangs the server on a
  broadly-filtered request. `solveCVRP`'s nearest-neighbour assignment is
  ~O(n^2) in the order count, and the endpoint had no size cap (unlike
  `compareHistory`'s `MAX_COMPARISON_CUSTOMERS`) — an unfiltered date filter
  could match hundreds of thousands of rows and peg the CPU. Added a
  `MAX_PRESALE_ORDERS` (3000) guard that returns a guidance message asking the
  caller to narrow the filter, instead of hanging.

## [1.4.0] - 2026-07-21

### Added

- History comparison (`compareHistory`) now geocodes a customer's location
  from their own `StoreName`/`CustomerName`/`DC_Name` when the `Customer_Code`
  is not found in Shop_Master (or its master coordinates never resolved),
  instead of silently dropping that customer from the comparison. Reuses the
  existing `routing/geocoder.js` provider (Longdo when configured, otherwise a
  no-op estimator), with repeat lookups for the same store memoized per
  comparison.

## [1.3.0] - 2026-07-21

### Added

- **Admin portal** (`public/admin.html`) — sign-in gated User Setup console for
  managing admin and driver accounts: create, reset password, and delete, with
  bearer-token session auth (`src/services/adminService.js`,
  `src/routes/adminRoutes.js`, `src/routes/requireAdmin.js`,
  `src/services/userService.js`, `src/db/seedAdmins.js`).
- **DC-aware routing** — each store now resolves its own distribution center
  from `dc list.xlsx` (parsed into `src/data/dcList.js`), so presale and
  history routes start and end at the correct DC instead of a single shared
  depot.
- Driver and planner UI updates (`public/driver.js/css/html`,
  `public/plan.js/css/html`, `public/app.js`, `public/filterOptions.js`,
  `public/progress.js`) alongside supporting database, schema, and ingestion
  changes.

### Fixed

- Admin portal login view no longer appears stuck on the sign-in screen after
  a successful login. `.auth-shell`'s `display: flex` tied in CSS specificity
  with the browser's default `[hidden] { display: none }` rule, so toggling
  `loginView.hidden` had no visual effect and the login card stayed on screen
  over the console view. Added `.auth-shell[hidden] { display: none; }` in
  `public/styles.css` to force it to hide, matching the existing
  `.filter-bar[hidden]` pattern.

## [1.2.1] - 2026-07-17

### Fixed

- History upload no longer fails when `TIME_VISIT` is a bare time-of-day such as
  `"7:08"`. The `time_visit` column is now `TEXT` (with an idempotent migration
  from the previous `TIMESTAMP` type), and the historical visit order sorts
  times chronologically rather than lexicographically.

## [1.2.0] - 2026-07-17

### Added

- Cross-platform local setup scripts (`scripts/setup.ps1` for Windows,
  `scripts/setup.sh` for macOS/Linux) that install Node.js and PostgreSQL (or a
  Docker container) and the npm dependencies, plus a README "Quick setup"
  pointer to them.

## [1.1.0] - 2026-07-17

### Added

- Route planner input page (`public/plan.html`, `plan.js`, `plan.css`) wired to
  the existing REST endpoints, with three sections:
  - Workbook upload (Shop_Master / History / Presale) with type auto-detect,
    row/mapped counts, detected headers, and a warnings table.
  - History comparison with column/date-range filters, rendering the original
    vs AI-optimized order and per-customer ETAs plus distance saved.
  - Presale planning with filters, rendering the optimized route, unassigned
    customers, and working-time-window violations.
- Pure, DOM-free planner view module (`public/planView.js`) with unit and
  property tests (`tests/planView.test.js`).
- Navigation link from the dashboard to the planner input page.
- Local development instructions in the README: PostgreSQL setup (including a
  Docker one-liner), driver seeding, page URLs, and DB-free test guidance.

### Security

- Documented that the planner endpoints (`/api/ingest/upload`,
  `/api/history/compare`, `/api/presale/plan`) are unauthenticated by design in
  this prototype; authentication must be added before any non-prototype
  deployment.

## [1.0.0] - 2026-07-17

Initial published version: the base route-optimization prototype plus the
Excel-driven route planning feature.

### Added

- **Core optimization** — Capacitated Vehicle Routing Problem (CVRP) solver
  using nearest-neighbour plus 2-opt (`src/optimizer/`), per-stop ETA service,
  CO₂ reduction metrics vs a naive baseline, and a pluggable routing layer
  (estimator by default, Longdo Map optional).
- **Leaflet dashboard** (`public/index.html`) with color-coded routes, stop
  sequence, ETAs, and headline metrics; REST API for the sample scenario and
  custom plans.
- **Excel ingestion** (`src/ingestion/`) — parse and validate the History,
  Shop_Master, and Presale workbooks (including Thai column headers), map rows
  to records with per-row warnings, and parse the customer code out of the
  Presale `CustomerName`.
- **PostgreSQL data layer** (`src/db/`) — raw parameterized SQL via `pg`,
  schema definition, upsert-on-conflict for shops, cross-workbook joins where
  master data wins, and a driver-seeding script.
- **Coordinate resolution** (`src/routing/geocoder.js`) — use Shop_Master
  coordinates first, fall back to Longdo geocoding, and exclude/flag
  unresolved or suspicious `(0,0)` coordinates.
- **History comparison** (`src/services/historyService.js`) — original order
  from `TIME_VISIT` vs an AI-optimized order, with per-customer ETAs, total
  distances, filters, and count/no-match guard messages.
- **Presale planning** (`src/services/presaleService.js`) — optimize a route
  from the presale list with capacity, per-stop service time, working-time
  window flags, unassigned-customer handling, and filters.
- **Driver app** — mobile-friendly view (`public/driver.html`) with a single
  assigned route, current-stop advancement, and Google Maps navigation handoff;
  driver authentication with scrypt-hashed passwords and persisted bearer-token
  sessions.
- **New REST endpoints** — `/api/ingest/upload`, `/api/history/compare`,
  `/api/presale/plan`, `/api/driver/login`, `/api/driver/route`.
- **Tests** — all 23 correctness properties covered with `fast-check`
  (≥100 runs each), plus example and DB-backed integration tests that skip
  cleanly without `DATABASE_URL`. The existing optimizer test suite runs
  unchanged.

### Dependencies

- Added `exceljs`, `multer`, and `pg`; added `fast-check` as a dev dependency.

[Unreleased]: https://github.com/Haku3989/route-optimization/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/Haku3989/route-optimization/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Haku3989/route-optimization/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Haku3989/route-optimization/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Haku3989/route-optimization/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Haku3989/route-optimization/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Haku3989/route-optimization/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Haku3989/route-optimization/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Haku3989/route-optimization/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Haku3989/route-optimization/releases/tag/v1.0.0
