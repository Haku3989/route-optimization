/**
 * History comparison service.
 *
 * Compares the ORIGINAL (historical) delivery order — derived from the
 * `TIME_VISIT` timestamps in the History_Workbook — against a freshly
 * AI-optimized order for the same set of customers, reporting a per-customer
 * estimated delivery time in both orderings plus the total route distance of
 * each ordering (Requirement 3). History records can be narrowed first with a
 * pure filter over the shared columns (Requirement 4).
 *
 * Reuse strategy (see design "History comparison"):
 *   - `repositories.joinHistory()` supplies the joined `{ history, shop }` rows
 *     (History LEFT JOIN Shop_Master on Customer_Code; master coords win).
 *   - The existing CVRP solver (`solveCVRP`) orders the same customer set with
 *     a single notional vehicle so the comparison isolates STOP ORDERING rather
 *     than fleet packing.
 *   - The routing layer (`createRouter`) + `etasFromLegs` produce per-stop ETAs,
 *     mirroring `routeService`'s leg computation.
 *   - `routeDistanceKm` reports the depot -> stops -> depot distance of each
 *     ordering.
 *
 * Dependency injection: `compareHistory` accepts a `deps` bag
 * (`{ repositories, router }`) that defaults to the real modules, so property
 * tests can pass an in-memory repository fake and never touch a database.
 */

import { solveCVRP, routeDistanceKm } from "../optimizer/vrp.js";
import { co2ForDistance } from "../optimizer/emissions.js";
import { etasFromLegs } from "./etaService.js";
import { createRouter } from "../routing/router.js";
import { createGeocoder } from "../routing/geocoder.js";
import { depot as sampleDepot } from "../data/sampleData.js";
import { resolveDcByName } from "../data/dcList.js";
import { buildGeocodeQuery } from "../routing/geocodeQuery.js";
import * as realRepositories from "../db/repositories.js";

/** Default depot reused from the existing sample scenario (Bangkok DC). */
const DEFAULT_DEPOT = { lat: sampleDepot.lat, lng: sampleDepot.lng };

/** Default notional single vehicle; capacity is sized to the customer set. */
const DEFAULT_SPEED_KMH = 35;

/**
 * Upper bound on the number of distinct customers a single comparison will
 * optimize. The comparison packs EVERY customer into one notional route and
 * runs a 2-opt refinement, which is superlinear; an unfiltered whole-dataset
 * request (thousands of stops) would otherwise peg the CPU and never return.
 * A route-sized cap keeps the comparison both fast and meaningful — the caller
 * narrows the set with filters (DC, store, area, date range) to stay under it.
 */
const MAX_COMPARISON_CUSTOMERS = 150;

/**
 * Guard messages returned (not thrown) for the count / no-match cases. Exported
 * so callers and tests can reference them without hard-coding brittle strings.
 */
export const HISTORY_MESSAGES = {
  NO_RECORDS_SELECTED: "no records selected",
  NEEDS_TWO_CUSTOMERS: "a comparison requires at least two customers",
  NO_RECORDS_MATCHED: "no records matched",
  NO_ROUTABLE_CUSTOMERS:
    "no routable customers — the matched history rows have no resolvable " +
    "shop coordinates (upload a Shop_Master workbook with matching " +
    "Customer_Code rows, check that their lat/long resolved, or that the " +
    "store/customer name could be geocoded)",
};

/**
 * Exact-match filter criteria mapped to their camelCase `history` fields. The
 * filter keys are the workbook column names used in the API/design; the entry
 * fields are the camelCase shapes produced by `repositories.joinHistory()`.
 */
const EXACT_MATCH_FIELDS = [
  ["DC_Name", "dcName"],
  ["StoreName", "storeName"],
  ["StoreGroup", "storeGroup"],
  ["Store Area", "storeArea"],
  ["CustomerType", "customerType"],
];

/**
 * A criterion is "absent" (matches everything) when it is undefined, null, or
 * an empty string.
 */
function isAbsent(value) {
  return value === undefined || value === null || value === "";
}

/**
 * Normalise a date-ish value (a `Date` as returned for a Postgres DATE
 * column, or a "YYYY-MM-DD"-prefixed string) to a `"YYYY-MM-DD"` key, or
 * `null` when missing/unparseable. String keys compare correctly with plain
 * `<`/`>` since ISO-format dates sort lexicographically the same as
 * chronologically.
 *
 * IMPORTANT: reads a `Date`'s LOCAL year/month/day, never UTC. node-postgres's
 * default DATE-column parser builds the JS `Date` from the server's LOCAL
 * timezone (e.g. `new Date(2026, 6, 17)` for a stored `'2026-07-17'`), so
 * recovering the intended calendar date requires the SAME local-time
 * reading. Using UTC getters here silently shifts the date by the server's
 * UTC offset (e.g. reading "2026-07-16" for a "2026-07-17" value at UTC+7) —
 * harmless-looking for a wide date RANGE, but it turns a single-day filter
 * (`deliveryDateFrom === deliveryDateTo`, as the dashboard's day-picker
 * always sends) into matching almost nothing, since the shifted invoice date
 * falls just outside the requested day's boundaries.
 */
function toDateKey(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const isoDateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  if (isoDateOnly) return isoDateOnly[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Ordering key for a `TIME_VISIT` value (Requirement 3.1).
 *
 * Real history files record the visit as a bare time-of-day such as `"7:08"`
 * (H:MM), which is not a parseable timestamp. This normalises the value to a
 * monotonic numeric key so the historical visit order sorts correctly:
 *   - a bare time-of-day `"H:MM"` / `"HH:MM"` / `"HH:MM:SS"` -> milliseconds
 *     since midnight;
 *   - a Date or a full date/time string -> epoch milliseconds;
 *   - anything unparseable / missing -> +Infinity (sorts last).
 *
 * Within a single history dataset the `TIME_VISIT` values share one format, so
 * the keys are mutually comparable and the resulting order is stable.
 *
 * @param {*} value
 * @returns {number}
 */
function visitOrderKey(value) {
  if (value == null || value === "") return Number.POSITIVE_INFINITY;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  }
  const s = String(value).trim();
  const tod = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (tod) {
    const hours = Number(tod[1]);
    const minutes = Number(tod[2]);
    const seconds = Number(tod[3] ?? 0);
    return ((hours * 60 + minutes) * 60 + seconds) * 1000; // ms since midnight
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Derive a depot from the filter's `StoreName` (preferred, more specific) or
 * `DC_Name`, via each string's leading 4-digit DC code (see `data/dcList.js`).
 * `null` when neither filter is supplied, or the supplied value's code does
 * not match a known DC.
 *
 * @param {object} [filters]
 * @returns {{lat:number,lng:number}|null}
 */
function depotFromFilters(filters) {
  if (!filters) return null;
  const dc = resolveDcByName(filters.StoreName) ?? resolveDcByName(filters.DC_Name);
  return dc ? { lat: dc.lat, lng: dc.lng } : null;
}

/**
 * Whether any filter criterion is actually supplied (used to distinguish
 * "no records selected" from "no records matched").
 *
 * @param {object} [filters]
 * @returns {boolean}
 */
export function hasAnyFilter(filters) {
  if (!filters) return false;
  for (const [filterKey] of EXACT_MATCH_FIELDS) {
    if (!isAbsent(filters[filterKey])) return true;
  }
  return !isAbsent(filters.deliveryDateFrom) || !isAbsent(filters.deliveryDateTo);
}

/**
 * Pure history filter (Requirement 4).
 *
 * Keeps only joined `{ history, shop }` items whose `history` fields match every
 * supplied exact-match criterion (`DC_Name`, `StoreName`, `StoreGroup`,
 * `"Store Area"`, `CustomerType`) AND whose `invoiceDate` falls within the
 * inclusive `[deliveryDateFrom, deliveryDateTo]` range. Absent/empty criteria
 * match everything, so an empty (or omitted) `filters` returns the input
 * unchanged (identity — Requirement 4.3).
 *
 * @param {Array<{ history: object, shop: object|null }>} joined
 * @param {object} [filters]
 * @returns {Array<{ history: object, shop: object|null }>}
 */
export function applyHistoryFilters(joined, filters) {
  if (!Array.isArray(joined)) return [];
  if (!filters) return joined.slice();

  const fromKey = toDateKey(filters.deliveryDateFrom);
  const toKey = toDateKey(filters.deliveryDateTo);
  const hasFrom = !isAbsent(filters.deliveryDateFrom);
  const hasTo = !isAbsent(filters.deliveryDateTo);

  return joined.filter((item) => {
    const history = item && item.history ? item.history : {};

    for (const [filterKey, field] of EXACT_MATCH_FIELDS) {
      const criterion = filters[filterKey];
      if (isAbsent(criterion)) continue;
      if (history[field] !== criterion) return false;
    }

    if (hasFrom || hasTo) {
      const invoiceKey = toDateKey(history.invoiceDate);
      // A supplied date-range criterion cannot be satisfied by a row without a
      // parseable delivered date.
      if (invoiceKey == null) return false;
      if (hasFrom && fromKey != null && invoiceKey < fromKey) return false;
      if (hasTo && toKey != null && invoiceKey > toKey) return false;
    }

    return true;
  });
}

/**
 * Build the best available query string to geocode a history row's own shop.
 * Delegates to `buildGeocodeQuery` — see `geocodeQuery.js` for the
 * customerName-cleaning + DC-area-context strategy and why it replaced a
 * plain storeName/customerName priority list.
 *
 * @param {object} history
 * @returns {string|null}
 */
function geocodeQueryFromHistory(history) {
  return buildGeocodeQuery(history);
}

/**
 * Geocode a single unresolved history row's location from its own
 * store/customer name (source "geocoded"), memoizing repeat lookups for the
 * same query within one comparison (the same store is typically visited many
 * times across the history rows). `null` when there is no usable query or the
 * geocoder itself returns nothing.
 *
 * @param {object} history
 * @param {{ geocode:(q:string)=>Promise<{lat:number,lng:number}|null> }} geocoder
 * @param {Map<string, {lat:number,lng:number}|null>} cache
 * @returns {Promise<{lat:number,lng:number}|null>}
 */
async function geocodeHistoryLocation(history, geocoder, cache) {
  const query = geocodeQueryFromHistory(history);
  if (!query) return null;

  if (cache.has(query)) return cache.get(query);
  const geocoded = await geocoder.geocode(query).catch(() => null);
  cache.set(query, geocoded ?? null);
  return geocoded ?? null;
}

/** Record `history`'s resolved `location` into `byCode`, keeping the EARLIEST
 * `timeVisit` per customer as the ordering key (Requirement 3.1). */
function addResolvedCustomer(byCode, history, location, shop) {
  const code = history.customerCode;
  const timeMs = visitOrderKey(history.timeVisit);

  const existing = byCode.get(code);
  if (!existing || timeMs < existing.timeMs) {
    byCode.set(code, {
      customerCode: code,
      customer: history.customerName ?? null,
      timeMs,
      location,
      serviceTimeMin: shop?.serviceTimeMin ?? null,
      openTime: shop?.openTime ?? null,
      closeTime: shop?.closeTime ?? null,
    });
  }
}

/**
 * Reduce filtered records to the DISTINCT customers that can actually be
 * routed, keyed by `customerCode`. A customer's location comes from the
 * joined Shop_Master row when present; when the `Customer_Code` is not found
 * in the master file (or its coordinates never resolved there), it is
 * geocoded from its own store/customer name instead of being dropped. The
 * returned list is sorted ascending by the earliest `timeVisit` per customer,
 * so it is the historical visit order (Requirement 3.1).
 *
 * Two passes, deliberately: master-resolved locations first (fast, no
 * network), THEN geocoding for the rest — but ONLY when the master-only
 * count is still within `maxCustomers`. An unfiltered request over a large
 * dataset can have tens of thousands of rows with no Shop_Master match; if
 * the master-only count already exceeds the cap, the comparison will be
 * rejected either way, so geocoding every remaining row would mean thousands
 * of real, sequential network calls for a result that gets thrown away.
 * Skipping that keeps an over-cap request fast and network-free, exactly the
 * case the dashboard's "too many customers" overview fallback needs to
 * render quickly.
 *
 * @param {Array<{ history: object, shop: object|null }>} records
 * @param {{ geocode:(q:string)=>Promise<{lat:number,lng:number}|null> }|null} [geocoder]
 * @param {number} [maxCustomers] see above; defaults to unbounded (always geocode)
 * @returns {Promise<Array<{ customerCode: string, customer: string, timeMs: number,
 *   location: {lat:number,lng:number}, serviceTimeMin: number|null,
 *   openTime: string|null, closeTime: string|null }>>}
 */
async function distinctResolvableCustomers(records, geocoder = null, maxCustomers = Infinity) {
  const byCode = new Map();
  const unresolved = [];

  // Pass 1 — master-resolved locations only.
  for (const item of records) {
    const history = item && item.history;
    if (!history) continue;
    const shop = item && item.shop;

    if (shop && shop.location) {
      addResolvedCustomer(byCode, history, shop.location, shop);
    } else {
      unresolved.push(history);
    }
  }

  // Pass 2 — geocode the rest, but only when it could still change the
  // outcome (see function doc).
  if (geocoder && byCode.size <= maxCustomers) {
    const geocodeCache = new Map();
    for (const history of unresolved) {
      const location = await geocodeHistoryLocation(history, geocoder, geocodeCache);
      if (location) addResolvedCustomer(byCode, history, location, null);
    }
  }

  return [...byCode.values()].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Turn a resolvable-customer descriptor into the optimizer's order shape. Demand
 * is a notional `1` per customer; combined with a capacity equal to the customer
 * count this guarantees a single route holds the whole set, isolating ordering.
 */
function toOrder(customer) {
  return {
    id: customer.customerCode,
    customer: customer.customer,
    demand: 1,
    location: customer.location,
    serviceTimeMin: customer.serviceTimeMin ?? undefined,
    openTime: customer.openTime ?? undefined,
    closeTime: customer.closeTime ?? undefined,
  };
}

/**
 * Compute per-stop ETAs for an ordered list of stops, mirroring `routeService`:
 * ask the router for the depot -> stops -> depot leg metrics, then derive ETAs
 * from those legs. Returns a `Map<customerCode, etaISO>`.
 */
async function etasByCode(router, depot, stops, departAt, speedKmh) {
  if (stops.length === 0) return new Map();
  const points = [depot, ...stops.map((s) => s.location), depot];
  const legs = await router.routeLegs(points, { speedKmh });
  const etas = etasFromLegs(stops, legs, departAt);
  const map = new Map();
  for (let i = 0; i < stops.length; i++) {
    map.set(stops[i].id, etas[i]?.etaISO ?? null);
  }
  return map;
}

/**
 * Compare the historical visit order against an AI-optimized order for a
 * filtered set of History records.
 *
 * @param {object} [input]
 * @param {object} [input.filters]   history filter criteria (Requirement 4)
 * @param {{lat:number,lng:number}} [input.depot]  explicit depot; when omitted,
 *   derived from the filter's StoreName (preferred) or DC_Name via its leading
 *   4-digit DC code (see `data/dcList.js`), falling back to the sample depot
 *   when neither is supplied or resolves to a known DC.
 * @param {{id?:string, speedKmh?:number}} [input.vehicle]  notional vehicle
 * @param {Date} [input.departAt]
 * @param {{ repositories?: object, router?: object, geocoder?: object }} [input.deps]
 *   Injectable dependencies; default to the real repository module, the
 *   configured router, and the configured geocoder (used to resolve a
 *   customer's location when it is not found in Shop_Master). Property tests
 *   pass in-memory fakes here.
 * @returns {Promise<
 *   { depot:{lat:number,lng:number},
 *     customers: Array<{ customerCode:string, customer:string,
 *       location:{lat:number,lng:number}|null,
 *       historicalSeq:number, optimizedSeq:number,
 *       historicalEta:string|null, optimizedEta:string|null }>,
 *     historicalDistanceKm:number, optimizedDistanceKm:number,
 *     historicalCo2Kg:number, optimizedCo2Kg:number }
 *   | { message: string }>}
 */
export async function compareHistory({
  filters = {},
  depot,
  vehicle,
  departAt = new Date(),
  deps = {},
} = {}) {
  const repositories = deps.repositories || realRepositories;
  const router = deps.router || createRouter();
  const geocoder = deps.geocoder || createGeocoder();

  // Resolve the depot: an explicit `depot` wins; otherwise derive it from the
  // filter's StoreName (preferred) or DC_Name — each store's leading 4-digit
  // code identifies its DC (see data/dcList.js), so the comparison's single
  // notional route starts/ends at THAT store's DC. Falls back to the sample
  // depot when neither is supplied or resolves to a known DC.
  const resolvedDepot = depot ?? depotFromFilters(filters) ?? DEFAULT_DEPOT;

  const joined = await repositories.joinHistory();
  const records = applyHistoryFilters(joined, filters);

  // The filter (or an empty store) excluded everything.
  if (records.length === 0) {
    if (hasAnyFilter(filters) && Array.isArray(joined) && joined.length > 0) {
      return { message: HISTORY_MESSAGES.NO_RECORDS_MATCHED }; // Req 4.4
    }
    return { message: HISTORY_MESSAGES.NO_RECORDS_SELECTED }; // Req 3.7
  }

  // Historical order = distinct routable customers, ascending by TIME_VISIT.
  const historicalCustomers = await distinctResolvableCustomers(
    records,
    geocoder,
    MAX_COMPARISON_CUSTOMERS
  );

  if (historicalCustomers.length === 0) {
    // `records` is non-empty here (the length===0 guard above already handled
    // that case), so this is NOT "no records selected" — real history rows
    // matched, but none of them joined to a shop with resolvable coordinates.
    // Report that distinctly rather than reusing the "nothing selected" message,
    // which reads as if the filter itself failed.
    return { message: HISTORY_MESSAGES.NO_ROUTABLE_CUSTOMERS }; // Req 3.7 (routable variant)
  }
  if (historicalCustomers.length === 1) {
    return { message: HISTORY_MESSAGES.NEEDS_TWO_CUSTOMERS }; // Req 3.6
  }
  if (historicalCustomers.length > MAX_COMPARISON_CUSTOMERS) {
    // Guard against optimizing an unfiltered whole-dataset request as one giant
    // route (which would hang the solver). Ask the caller to narrow the set.
    return {
      message:
        `Too many customers (${historicalCustomers.length}) for one comparison. ` +
        `Apply a filter (DC, store, area, or date range) to narrow to a ` +
        `route-sized set of ${MAX_COMPARISON_CUSTOMERS} or fewer.`,
    };
  }

  const speedKmh = (vehicle && vehicle.speedKmh) || DEFAULT_SPEED_KMH;
  const orders = historicalCustomers.map(toOrder);

  // Optimize the SAME customer set with a single notional vehicle whose capacity
  // holds the whole set (Requirement 3.2).
  const notionalVehicle = {
    id: (vehicle && vehicle.id) || "HIST-1",
    capacity: orders.length,
    speedKmh,
  };
  const { routes } = solveCVRP({ depot: resolvedDepot, vehicles: [notionalVehicle], orders });
  const optimizedStops = routes.flatMap((route) => route.stops);

  const historicalStops = historicalCustomers.map((customer) => ({
    id: customer.customerCode,
    location: customer.location,
    serviceTimeMin: customer.serviceTimeMin ?? undefined,
    openTime: customer.openTime ?? undefined,
    closeTime: customer.closeTime ?? undefined,
  }));

  // Per-customer ETAs for BOTH orderings (Requirement 3.3).
  const [historicalEtas, optimizedEtas] = await Promise.all([
    etasByCode(router, resolvedDepot, historicalStops, departAt, speedKmh),
    etasByCode(router, resolvedDepot, optimizedStops, departAt, speedKmh),
  ]);

  // Sequence positions per ordering (1-based).
  const historicalSeqByCode = new Map(
    historicalStops.map((stop, i) => [stop.id, i + 1])
  );
  const optimizedSeqByCode = new Map(
    optimizedStops.map((stop, i) => [stop.id, i + 1])
  );

  // Per-customer rows, emitted in historical order (Requirement 3.4).
  // `location` is included so callers (e.g. the dashboard map) can plot each
  // stop; it is additive and does not affect the comparison itself.
  const customers = historicalCustomers.map((customer) => ({
    customerCode: customer.customerCode,
    customer: customer.customer,
    location: customer.location,
    historicalSeq: historicalSeqByCode.get(customer.customerCode),
    optimizedSeq: optimizedSeqByCode.get(customer.customerCode),
    historicalEta: historicalEtas.get(customer.customerCode) ?? null,
    optimizedEta: optimizedEtas.get(customer.customerCode) ?? null,
  }));

  // Totals: depot -> stops -> depot distance of each ordering (Requirement 3.5).
  const historicalDistanceKm = round(routeDistanceKm(resolvedDepot, historicalStops));
  const optimizedDistanceKm = round(routeDistanceKm(resolvedDepot, optimizedStops));

  // CO2 estimate for each ordering, using the default (diesel) emission factor
  // so the dashboard can show an emissions saving alongside the distance saving.
  const historicalCo2Kg = round(co2ForDistance(historicalDistanceKm, {}));
  const optimizedCo2Kg = round(co2ForDistance(optimizedDistanceKm, {}));

  return {
    depot: resolvedDepot,
    customers,
    historicalDistanceKm,
    optimizedDistanceKm,
    historicalCo2Kg,
    optimizedCo2Kg,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Overview counts of the uploaded History data, grouped by DC_Name and by
 * StoreName (busiest first). Used by the dashboard as a fallback "big
 * picture" view when no filter has narrowed the comparison down to a
 * routable set — e.g. when `compareHistory` reports the "too many
 * customers" guard message — so the user sees the shape of the whole
 * dataset instead of just that guard text, and can pick a DC/store to
 * filter into.
 *
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{
 *   byDc: Array<{ dcName:string, visits:number, customers:number }>,
 *   byStore: Array<{ storeName:string, dcName:string|null, visits:number, customers:number }>
 * }>}
 */
export async function getHistoryOverview(deps = {}) {
  const repositories = deps.repositories || realRepositories;
  return repositories.historyOverview();
}

/**
 * Distinct History dates that have data, scoped by the given categorical
 * filters (day-picker cascading — see `repositories.distinctHistoryDates`).
 *
 * @param {object} [activeFilters]
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<string[]>} ascending `YYYY-MM-DD` strings
 */
export async function getHistoryDates(activeFilters = {}, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  return repositories.distinctHistoryDates(activeFilters);
}
