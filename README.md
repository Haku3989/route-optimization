# Farmhouse Route Optimization

AI-driven delivery route optimization prototype, built from the Saha Group
"Working Backwards" ideation workshop use-case (team **Farmhouse**).

The workshop framed the problem as: delivery routes are planned manually,
there is no real-time visibility, and fuel cost / time / CO₂ are high. This
prototype turns that idea into a working system.

## What it does

- **Route optimization** — solves a Capacitated Vehicle Routing Problem
  (CVRP) across a mixed fleet using a nearest-neighbour heuristic plus 2-opt
  local search.
- **Real-time ETA** — computes an estimated arrival time for every stop from
  driving distance, vehicle speed and per-stop service time.
- **ERP/WMS-style feed** — sample order data models what would come from
  Farmhouse's ERP/WMS (customers, demand, locations).
- **CO₂ reduction metrics** — compares the optimized plan against a naive
  baseline and reports distance and CO₂ saved. EVs use a lower emission
  factor, so shifting load to EVs improves the numbers.
- **Dashboard** — a Leaflet map with color-coded routes, stop sequence,
  ETAs, and headline business metrics.

## Mapping to the workshop template

| Workshop question        | In this project                                             |
| ------------------------ | ----------------------------------------------------------- |
| Who is the customer?     | Dispatch / fleet managers and delivery drivers at Farmhouse |
| Customer problem         | Manual routing, no real-time ETA, high fuel & CO₂           |
| Solution                 | AI CVRP optimizer + real-time ETA + ERP/WMS integration     |
| Customer experience      | Map view, per-stop ETA, EV-aware planning                   |
| How to measure success   | Distance saved, CO₂ saved, fleet utilization                |

## Running locally

### Quick setup (scripts)

To bootstrap the tooling (Node.js, PostgreSQL) and install dependencies in one
step, run the setup script for your platform from the project root:

```powershell
# Windows (PowerShell) — add -UseDocker to run PostgreSQL in a container
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

```bash
# macOS / Linux — add --use-docker to run PostgreSQL in a container
bash scripts/setup.sh
```

The scripts are idempotent (they only install what is missing) and print the
next steps when done. Prefer to set things up by hand? Follow the manual steps
below.

### Prerequisites

- Node.js 18+ (the app uses built-in `fetch` and `node:test`).
- A PostgreSQL instance (14+ recommended). The server verifies the database is
  reachable on startup and exits with a clear message if it is not, so Postgres
  must be running before `npm start`.

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL and point the app at it

Configure the connection with either a single `DATABASE_URL` or the discrete
`PG*` variables. No credentials are hard-coded.

Fastest path with Docker:

```bash
docker run --name farmhouse-pg \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=route_optimization \
  -p 5432:5432 -d postgres:16
```

Then set the connection string (bash/macOS/Linux):

```bash
export DATABASE_URL="postgres://postgres:password@localhost:5432/route_optimization"
```

On Windows PowerShell:

```powershell
$env:DATABASE_URL = "postgres://postgres:password@localhost:5432/route_optimization"
```

The schema is created automatically on startup and on seeding
(`CREATE TABLE IF NOT EXISTS`), so there is no separate migration step.

### 3. Seed a driver (needed for the driver app)

Set a real password rather than the local-dev placeholder, then seed:

```bash
export SEED_DRIVER_USERNAME="driver1"
export SEED_DRIVER_PASSWORD="choose-a-password"
npm run db:seed
```

(PowerShell: use `$env:SEED_DRIVER_USERNAME = "driver1"` etc.)

### 4. Start the server

```bash
npm start
```

Then open:

- **Dashboard** — http://localhost:3000 (sample CVRP optimizer + map)
- **Route planner input** — http://localhost:3000/plan.html (upload workbooks,
  history comparison, presale planning)
- **Driver app** — http://localhost:3000/driver.html (log in with the seeded
  driver, follow the route, hand off to Google Maps)

Set `PORT` to use a specific port (e.g. `PORT=4000 npm start`); otherwise the
server falls back to the next free port if 3000 is taken.

### Running the tests (no database required)

```bash
npm test
```

The unit and property tests run without Postgres. The database-backed
integration tests skip automatically unless `TEST_DATABASE_URL` is set — a
**separate** variable from the `DATABASE_URL` you set above for running the
app. This is deliberate: every integration test truncates all tables between
cases for isolation, so if they read the same `DATABASE_URL` you use to run
the app, running `npm test` in any shell where that's still exported would
silently wipe your real data. Point `TEST_DATABASE_URL` at a disposable
database (never your dev one) to run them, e.g.:

```bash
export TEST_DATABASE_URL="postgres://postgres:password@localhost:5432/route_optimization_test"
npm test
```

## API

| Method | Endpoint            | Description                                  |
| ------ | ------------------- | -------------------------------------------- |
| GET    | `/api/health`       | Liveness probe                               |
| GET    | `/api/scenario`     | Sample depot, fleet and orders (ERP/WMS feed)|
| GET    | `/api/plan/sample`  | Optimized plan for the sample scenario       |
| POST   | `/api/plan`         | Optimized plan for a custom payload          |

### POST /api/plan payload

```json
{
  "depot": { "lat": 13.7563, "lng": 100.5018 },
  "vehicles": [
    { "id": "TRK-01", "capacity": 60, "fuelType": "diesel", "speedKmh": 35 },
    { "id": "EV-01",  "capacity": 30, "fuelType": "ev",     "speedKmh": 40 }
  ],
  "orders": [
    { "id": "SO-1", "customer": "Store A", "demand": 12,
      "location": { "lat": 13.72, "lng": 100.53 } }
  ]
}
```

## Project structure

```
src/
  optimizer/
    distance.js    Haversine + road-detour distance, distance matrix
    emissions.js   CO2 emission factors (diesel / petrol / ev)
    vrp.js         CVRP solver (nearest-neighbour + 2-opt)
  routing/
    router.js      Pluggable routing layer (estimator / Longdo)
  services/
    etaService.js  Per-stop ETA calculation
    routeService.js Plan orchestration + success metrics
  data/
    sampleData.js  ERP/WMS-style sample scenario (Bangkok)
  routes/
    api.js         REST endpoints
  server.js        Express app + static dashboard
public/            Leaflet dashboard (index.html, app.js, styles.css)
tests/             node:test unit tests
```

## Routing provider

The CVRP solver always decides the visit order with the fast built-in
distance estimate. Once a plan is finalized, a pluggable routing layer
computes the *reported* distance and travel time per leg — which is what the
metrics and per-stop ETAs are built from. The active provider is echoed back
on every plan as `routingProvider`.

| Provider    | Distance / duration source                         | Config                       |
| ----------- | -------------------------------------------------- | ---------------------------- |
| `estimator` | Haversine × 1.3 detour, duration from speed (default) | none                      |
| `longdo`    | Longdo Map RouteService (real road network)        | `LONGDO_API_KEY` required    |

Select the provider with environment variables:

```bash
# Default estimator (no key, no network)
npm start

# Real road distances and travel time via Longdo
ROUTING_PROVIDER=longdo LONGDO_API_KEY=your_key npm start
```

If `ROUTING_PROVIDER=longdo` is set but `LONGDO_API_KEY` is missing, the
service logs a warning and falls back to the estimator. Optional overrides:
`LONGDO_ROUTE_MODE` (default `t`, fastest with traffic) and `LONGDO_BASE_URL`.

To avoid exporting these every session, create a `.env` file in the project
root (already covered by `.gitignore` — never commit it):

```
LONGDO_API_KEY=your_key
ROUTING_PROVIDER=longdo
```

`npm start`, `npm run dev`, and `npm run db:seed*` load it automatically via
Node's built-in `--env-file-if-exists` (Node 20.12+/22.9+). `npm test` does
NOT load it, so the test suite stays key-free and network-free.

## Notes and limitations

- The optimizer is a heuristic (VRP is NP-hard); it favors speed over exact
  optimality. Good enough for dispatch, and easy to swap for OR-Tools later.
- Distances default to an estimate (Haversine × 1.3 detour factor). For real
  road-network distance and travel time, set `ROUTING_PROVIDER=longdo` (see
  [Routing provider](#routing-provider)).
- Emission factors are approximate industry averages.
