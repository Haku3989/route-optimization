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

## Getting started

```bash
npm install
npm start
```

Then open http://localhost:3000

Run the tests:

```bash
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

## Notes and limitations

- The optimizer is a heuristic (VRP is NP-hard); it favors speed over exact
  optimality. Good enough for dispatch, and easy to swap for OR-Tools later.
- Distances default to an estimate (Haversine × 1.3 detour factor). For real
  road-network distance and travel time, set `ROUTING_PROVIDER=longdo` (see
  [Routing provider](#routing-provider)).
- Emission factors are approximate industry averages.
