# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Admin portal (`public/admin.html`) no longer appears stuck on the sign-in
  screen after a successful login. `.auth-shell`'s `display: flex` tied in CSS
  specificity with the browser's default `[hidden] { display: none }` rule, so
  toggling `loginView.hidden` had no visual effect and the login card stayed
  on screen over the console view. Added `.auth-shell[hidden] { display: none; }`
  in `public/styles.css` to force it to hide, matching the existing
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

[Unreleased]: https://github.com/Haku3989/route-optimization/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/Haku3989/route-optimization/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Haku3989/route-optimization/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Haku3989/route-optimization/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Haku3989/route-optimization/releases/tag/v1.0.0
