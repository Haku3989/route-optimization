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
import { etasFromLegs } from "./etaService.js";
import { createRouter } from "../routing/router.js";
import { depot as sampleDepot } from "../data/sampleData.js";
import * as realRepositories from "../db/repositories.js";

/** Default depot reused from the existing sample scenario (Bangkok DC). */
const DEFAULT_DEPOT = { lat: sampleDepot.lat, lng: sampleDepot.lng };

/** Default notional single vehicle; capacity is sized to the customer set. */
const DEFAULT_SPEED_KMH = 35;

/**
 * Guard messages returned (not thrown) for the count / no-match cases. Exported
 * so callers and tests can reference them without hard-coding brittle strings.
 */
export const HISTORY_MESSAGES = {
  NO_RECORDS_SELECTED: "no records selected",
  NEEDS_TWO_CUSTOMERS: "a comparison requires at least two customers",
  NO_RECORDS_MATCHED: "no records matched",
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
 * Normalise a date-ish value (Date, ISO string, "YYYY-MM-DD") to epoch ms, or
 * `null` when it is missing / unparseable.
 */
function toTimeMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
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

  const fromMs = toTimeMs(filters.deliveryDateFrom);
  const toMs = toTimeMs(filters.deliveryDateTo);
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
      const invoiceMs = toTimeMs(history.invoiceDate);
      // A supplied date-range criterion cannot be satisfied by a row without a
      // parseable delivered date.
      if (invoiceMs == null) return false;
      if (hasFrom && fromMs != null && invoiceMs < fromMs) return false;
      if (hasTo && toMs != null && invoiceMs > toMs) return false;
    }

    return true;
  });
}

/**
 * Reduce filtered records to the DISTINCT customers that can actually be routed
 * (those whose joined Shop_Master row resolved to coordinates), keyed by
 * `customerCode`, keeping the EARLIEST `timeVisit` per customer as the ordering
 * key. The returned list is sorted ascending by that earliest `timeVisit`, so
 * it is the historical visit order (Requirement 3.1).
 *
 * @param {Array<{ history: object, shop: object|null }>} records
 * @returns {Array<{ customerCode: string, customer: string, timeMs: number,
 *   location: {lat:number,lng:number}, serviceTimeMin: number|null,
 *   openTime: string|null, closeTime: string|null }>}
 */
function distinctResolvableCustomers(records) {
  const byCode = new Map();

  for (const item of records) {
    const history = item && item.history;
    const shop = item && item.shop;
    if (!history || !shop || !shop.location) continue; // not routable

    const code = history.customerCode;
    const timeMs = toTimeMs(history.timeVisit) ?? Number.POSITIVE_INFINITY;

    const existing = byCode.get(code);
    if (!existing || timeMs < existing.timeMs) {
      byCode.set(code, {
        customerCode: code,
        customer: history.customerName ?? null,
        timeMs,
        location: shop.location,
        serviceTimeMin: shop.serviceTimeMin ?? null,
        openTime: shop.openTime ?? null,
        closeTime: shop.closeTime ?? null,
      });
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
 * @param {{lat:number,lng:number}} [input.depot]
 * @param {{id?:string, speedKmh?:number}} [input.vehicle]  notional vehicle
 * @param {Date} [input.departAt]
 * @param {{ repositories?: object, router?: object }} [input.deps]
 *   Injectable dependencies; default to the real repository module and the
 *   configured router. Property tests pass in-memory fakes here.
 * @returns {Promise<
 *   { customers: Array<{ customerCode:string, customer:string,
 *       historicalSeq:number, optimizedSeq:number,
 *       historicalEta:string|null, optimizedEta:string|null }>,
 *     historicalDistanceKm:number, optimizedDistanceKm:number }
 *   | { message: string }>}
 */
export async function compareHistory({
  filters = {},
  depot = DEFAULT_DEPOT,
  vehicle,
  departAt = new Date(),
  deps = {},
} = {}) {
  const repositories = deps.repositories || realRepositories;
  const router = deps.router || createRouter();

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
  const historicalCustomers = distinctResolvableCustomers(records);

  if (historicalCustomers.length === 0) {
    return { message: HISTORY_MESSAGES.NO_RECORDS_SELECTED }; // Req 3.7
  }
  if (historicalCustomers.length === 1) {
    return { message: HISTORY_MESSAGES.NEEDS_TWO_CUSTOMERS }; // Req 3.6
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
  const { routes } = solveCVRP({ depot, vehicles: [notionalVehicle], orders });
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
    etasByCode(router, depot, historicalStops, departAt, speedKmh),
    etasByCode(router, depot, optimizedStops, departAt, speedKmh),
  ]);

  // Sequence positions per ordering (1-based).
  const historicalSeqByCode = new Map(
    historicalStops.map((stop, i) => [stop.id, i + 1])
  );
  const optimizedSeqByCode = new Map(
    optimizedStops.map((stop, i) => [stop.id, i + 1])
  );

  // Per-customer rows, emitted in historical order (Requirement 3.4).
  const customers = historicalCustomers.map((customer) => ({
    customerCode: customer.customerCode,
    customer: customer.customer,
    historicalSeq: historicalSeqByCode.get(customer.customerCode),
    optimizedSeq: optimizedSeqByCode.get(customer.customerCode),
    historicalEta: historicalEtas.get(customer.customerCode) ?? null,
    optimizedEta: optimizedEtas.get(customer.customerCode) ?? null,
  }));

  // Totals: depot -> stops -> depot distance of each ordering (Requirement 3.5).
  const historicalDistanceKm = round(routeDistanceKm(depot, historicalStops));
  const optimizedDistanceKm = round(routeDistanceKm(depot, optimizedStops));

  return { customers, historicalDistanceKm, optimizedDistanceKm };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
