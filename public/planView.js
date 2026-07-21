/**
 * Planner view — PURE view logic for the route-input page.
 *
 * This module is the single source of truth for the planner-view behaviour that
 * can be reasoned about without a browser: building request filter objects from
 * raw form inputs, and shaping the History-comparison and Presale-plan API
 * responses (including their `{ message }` guard shapes) into small view-models
 * the DOM layer can paint directly.
 *
 * IMPORTANT: this module performs NO DOM access and NO network access at import
 * time (no `document`, no `window`, no `fetch`). It is a plain ES module that
 * runs identically in the browser (imported by `public/plan.js`) and under
 * Node's `node:test` runner (imported by `tests/planView.test.js`). All DOM /
 * fetch wiring lives in `public/plan.js`, which imports from here.
 *
 * The API response shapes mirrored here come from (do NOT change the backend):
 *   - POST /api/history/compare -> historyService.compareHistory
 *       { depot:{lat,lng},
 *         customers:[{customerCode, customer, location:{lat,lng}|null,
 *         historicalSeq, optimizedSeq, historicalEta, optimizedEta}],
 *         historicalDistanceKm, optimizedDistanceKm,
 *         historicalCo2Kg, optimizedCo2Kg } | { message }
 *   - POST /api/presale/plan -> presaleService.buildPresalePlan
 *       { plan, unassigned:[{customerCode, customer, reason}],
 *         windowViolations:[{customerCode, eta, openTime, closeTime}] }
 *       | { message }
 *     where plan (routeService.planDeliveries) is
 *       { routes:[{ vehicleId, fuelType, distanceKm, co2Kg, load, capacity,
 *         stops:[{ orderId, customer, demand, sequence, eta, cumulativeKm,
 *         location, address }] }], unassignedOrders, metrics, ... }
 */

/**
 * Round a number to two decimal places (mirrors the backend's `round`).
 * @param {number} n
 * @returns {number}
 */
function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * A raw form value is "empty" when it is undefined, null, or trims to "".
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmpty(value) {
  if (value === undefined || value === null) return true;
  return String(value).trim() === "";
}

/**
 * True when `value` is a `{ lat, lng }` object with finite numeric coordinates.
 * @param {unknown} value
 * @returns {boolean}
 */
function isLatLng(value) {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng)
  );
}

/**
 * Sanitize a `legsGeometry`-shaped array (one entry per leg: real
 * road-snapped points, or `null` when unavailable) into a render-ready form —
 * each non-null entry filtered/mapped to plain `{lat,lng}` pairs, entries
 * that aren't a usable point array collapse to `null`. Pure; never throws on
 * a malformed/missing input.
 *
 * @param {unknown} legsGeometry
 * @returns {Array<Array<{lat:number,lng:number}>|null>}
 */
function sanitizeLegsGeometry(legsGeometry) {
  if (!Array.isArray(legsGeometry)) return [];
  return legsGeometry.map((leg) => {
    if (!Array.isArray(leg) || leg.length === 0) return null;
    const points = leg.filter(isLatLng).map((p) => ({ lat: p.lat, lng: p.lng }));
    return points.length > 0 ? points : null;
  });
}

/**
 * Build a request `filters` object from raw form inputs, keeping ONLY the keys
 * whose values are non-empty (after trimming). Whitespace-only values are
 * dropped so an untouched field never over-constrains the query; provided
 * values are trimmed. Pure and non-mutating.
 *
 * @param {Record<string, unknown>} inputs raw `{ key: rawValue }` map
 * @returns {Record<string, string>} only the non-empty keys, trimmed
 */
export function buildFilters(inputs) {
  const filters = {};
  if (!inputs || typeof inputs !== "object") return filters;
  for (const key of Object.keys(inputs)) {
    const value = inputs[key];
    if (isEmpty(value)) continue;
    filters[key] = String(value).trim();
  }
  return filters;
}

/**
 * Format an ISO timestamp as a `HH:MM` wall-clock string, or a dash when it is
 * absent. Falls back to the raw string when it is not a parseable date. Pure.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function fmtEta(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Shape a History-comparison API response into a view-model. Handles both the
 * `{ message }` guard shape (0 / 1 / no-match cases) and the full comparison
 * shape, and computes the distance saved (km + percent) from the totals.
 *
 * savedKm  = historicalDistanceKm - optimizedDistanceKm
 * savedPct = historicalDistanceKm === 0 ? 0 : savedKm / historicalDistanceKm * 100
 *
 * co2SavedKg = historicalCo2Kg - optimizedCo2Kg
 *
 * The `depot`, per-row `location`, and CO2 fields are additive: they carry the
 * geo + emissions data the dashboard map/metric cards need, and default safely
 * (null depot, null location, 0 CO2) when a caller — like the planner table —
 * ignores them.
 *
 * `historicalRouteGeometry`/`optimizedRouteGeometry` are additive: one entry
 * per leg (depot->stop1, ..., lastStop->depot) of real road-snapped points,
 * or `null` per-leg when unavailable — the map draws a straight line for any
 * `null` leg instead of failing the whole polyline.
 *
 * @param {object} result the parsed JSON body from /api/history/compare
 * @returns {{ isMessage: boolean, message?: string,
 *   depot: {lat:number,lng:number}|null, rows: Array<object>,
 *   historicalDistanceKm: number, optimizedDistanceKm: number,
 *   savedKm: number, savedPct: number,
 *   historicalCo2Kg: number, optimizedCo2Kg: number, co2SavedKg: number,
 *   historicalRouteGeometry: Array<Array<{lat:number,lng:number}>|null>,
 *   optimizedRouteGeometry: Array<Array<{lat:number,lng:number}>|null> }}
 */
export function summarizeComparison(result) {
  if (!result || typeof result !== "object" || typeof result.message === "string") {
    return {
      isMessage: true,
      message: result && result.message ? result.message : "No result.",
      depot: null,
      rows: [],
      historicalDistanceKm: 0,
      optimizedDistanceKm: 0,
      savedKm: 0,
      savedPct: 0,
      historicalCo2Kg: 0,
      optimizedCo2Kg: 0,
      co2SavedKg: 0,
      historicalRouteGeometry: [],
      optimizedRouteGeometry: [],
    };
  }

  const historicalDistanceKm = Number(result.historicalDistanceKm) || 0;
  const optimizedDistanceKm = Number(result.optimizedDistanceKm) || 0;
  const savedKm = round(historicalDistanceKm - optimizedDistanceKm);
  const savedPct =
    historicalDistanceKm === 0
      ? 0
      : round(((historicalDistanceKm - optimizedDistanceKm) / historicalDistanceKm) * 100);

  const historicalCo2Kg = Number(result.historicalCo2Kg) || 0;
  const optimizedCo2Kg = Number(result.optimizedCo2Kg) || 0;
  const co2SavedKg = round(historicalCo2Kg - optimizedCo2Kg);

  const depot = isLatLng(result.depot) ? { lat: result.depot.lat, lng: result.depot.lng } : null;

  const rows = Array.isArray(result.customers)
    ? result.customers.map((c) => ({
        customerCode: c.customerCode ?? null,
        customer: c.customer ?? null,
        location: isLatLng(c.location) ? { lat: c.location.lat, lng: c.location.lng } : null,
        historicalSeq: c.historicalSeq ?? null,
        optimizedSeq: c.optimizedSeq ?? null,
        historicalEta: c.historicalEta ?? null,
        optimizedEta: c.optimizedEta ?? null,
      }))
    : [];

  return {
    isMessage: false,
    depot,
    rows,
    historicalDistanceKm: round(historicalDistanceKm),
    optimizedDistanceKm: round(optimizedDistanceKm),
    savedKm,
    savedPct,
    historicalCo2Kg: round(historicalCo2Kg),
    optimizedCo2Kg: round(optimizedCo2Kg),
    co2SavedKg,
    historicalRouteGeometry: sanitizeLegsGeometry(result.historicalRouteGeometry),
    optimizedRouteGeometry: sanitizeLegsGeometry(result.optimizedRouteGeometry),
  };
}

/**
 * Shape a Presale-plan API response into a view-model. Handles the `{ message }`
 * guard shape and the `{ plan, unassigned, windowViolations }` shape, flattening
 * the plan's routes into a single ordered display list of stops (each tagged
 * with its owning vehicle) so the DOM layer can render per-route or as a flat
 * list without further traversal.
 *
 * The per-route `depot` is additive: it reports the DC (start/end point) that
 * route's vehicle actually used — a store's own DC when its StoreName resolves
 * to one (see `data/dcList.js`), otherwise the plan-level depot. `null` when
 * the route carries no depot (older responses).
 *
 * A stop's `location`/`address` are additive (present when the underlying
 * order carried them) so a map view (e.g. the dashboard's Presale preview)
 * can plot markers without re-deriving them; the flat table view on the
 * planner page simply ignores the extra fields.
 *
 * @param {object} result the parsed JSON body from /api/presale/plan
 * @returns {{ isMessage: boolean, message?: string,
 *   routes: Array<{ vehicleId: (string|null), fuelType: (string|null),
 *     distanceKm: number, co2Kg: number, load: (number|null),
 *     capacity: (number|null), depot: ({lat:number,lng:number}|null),
 *     legsGeometry: Array<Array<{lat:number,lng:number}>|null>,
 *     stops: Array<{ sequence:(number|null), customer:(string|null),
 *       customerCode:(string|null), eta:(string|null), demand:(number|null),
 *       location:({lat:number,lng:number}|null), address:(string|null) }> }>,
 *   stops: Array<object>,
 *   unassigned: Array<{ customerCode:(string|null), customer:(string|null), reason:(string|null) }>,
 *   windowViolations: Array<{ customerCode:(string|null), eta:(string|null),
 *     openTime:(string|null), closeTime:(string|null) }> }}
 */
export function summarizePlan(result) {
  if (!result || typeof result !== "object" || typeof result.message === "string") {
    return {
      isMessage: true,
      message: result && result.message ? result.message : "No result.",
      routes: [],
      stops: [],
      unassigned: [],
      windowViolations: [],
    };
  }

  const plan = result.plan && typeof result.plan === "object" ? result.plan : {};
  const planRoutes = Array.isArray(plan.routes) ? plan.routes : [];

  const routes = planRoutes
    .filter((route) => Array.isArray(route.stops) && route.stops.length > 0)
    .map((route) => ({
      vehicleId: route.vehicleId ?? null,
      fuelType: route.fuelType ?? null,
      distanceKm: Number(route.distanceKm) || 0,
      co2Kg: Number(route.co2Kg) || 0,
      load: route.load ?? null,
      capacity: route.capacity ?? null,
      depot: isLatLng(route.depot)
        ? {
            lat: route.depot.lat,
            lng: route.depot.lng,
            code: route.depot.code ?? null,
            name: route.depot.name ?? null,
          }
        : null,
      // One entry per leg (depot->stop1, ..., lastStop->depot); the map
      // draws a straight line for any null leg. See summarizeComparison's
      // doc for the same convention.
      legsGeometry: sanitizeLegsGeometry(route.legsGeometry),
      stops: route.stops.map((stop) => ({
        sequence: stop.sequence ?? null,
        customer: stop.customer ?? null,
        customerCode: stop.orderId ?? null,
        eta: stop.eta ?? null,
        demand: stop.demand ?? null,
        location: isLatLng(stop.location) ? { lat: stop.location.lat, lng: stop.location.lng } : null,
        address: stop.address ?? null,
      })),
    }));

  // Flatten routes into one display list, each stop tagged with its vehicle.
  const stops = routes.flatMap((route) =>
    route.stops.map((stop) => ({ ...stop, vehicleId: route.vehicleId }))
  );

  const unassigned = Array.isArray(result.unassigned)
    ? result.unassigned.map((u) => ({
        customerCode: u.customerCode ?? null,
        customer: u.customer ?? null,
        reason: u.reason ?? null,
      }))
    : [];

  const windowViolations = Array.isArray(result.windowViolations)
    ? result.windowViolations.map((w) => ({
        customerCode: w.customerCode ?? null,
        eta: w.eta ?? null,
        openTime: w.openTime ?? null,
        closeTime: w.closeTime ?? null,
      }))
    : [];

  return { isMessage: false, routes, stops, unassigned, windowViolations };
}
