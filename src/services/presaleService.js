/**
 * Presale plan service.
 *
 * Builds and optimizes a delivery route from the Presale customer list. Each
 * Presale entry is joined to its Shop_Master row on `Customer_Code` (master
 * data wins for coordinates / service time / working time — Requirement 2.5),
 * narrowed with a pure filter over the shared columns (Requirement 6), split
 * into routable orders vs unassigned customers (Requirement 5.5), optimized and
 * ETA'd through the existing `routeService.planDeliveries` (Requirements 5.2,
 * 5.3), and finally checked for working-time-window violations (Requirement
 * 7.1).
 *
 * Reuse strategy (see design "Presale plan — services/presaleService.js"):
 *   - `repositories.joinPresale()` supplies the joined `{ presale, shop }` rows
 *     (Presale LEFT JOIN Shop_Master on Customer_Code). `shop` is `null` when no
 *     master row matched; `shop.location` is `null` when the master row had no
 *     resolvable coordinates.
 *   - `routeService.planDeliveries` runs the CVRP solver + routing/ETA layer.
 *     Its signature is kept intact; because it does not currently accept ETA
 *     options, the working-time-window check is computed here from the plan's
 *     per-stop ETAs using the same wall-clock semantics as `etaService`.
 *
 * ## Filtering semantics (Requirement 6, documented)
 *
 * The Presale filter accepts `DC_Name`, `StoreName`, `DELIVERY_DATE`,
 * `StoreGroup`, `Store Area`, and `CustomerType`. Per the design these may be
 * drawn from the Presale row OR the joined Shop_Master/History data. In this
 * project the joined shop record only carries coordinates / service time /
 * working time (it does NOT carry DC/store/group/area/type), and only
 * `DELIVERY_DATE` lives on the presale row (`deliveryDate`). Therefore:
 *   - `DELIVERY_DATE` is matched against `presale.deliveryDate` (a supplied
 *     date criterion excludes a row that has no delivery date, mirroring the
 *     history date-range filter).
 *   - Each shop-derived dimension (`DC_Name`, `StoreName`, `StoreGroup`,
 *     `Store Area`, `CustomerType`) is matched against whatever field exists on
 *     the joined item (checked on `presale` first, then `shop`). A supplied
 *     criterion excludes a row ONLY when that field is present on the row and
 *     differs; when the field is absent from the row, that dimension is ignored
 *     for that row (it cannot exclude data the join does not carry).
 *   - An absent/empty criterion matches everything, so empty (or omitted)
 *     `filters` is the identity (Requirement 6.2).
 *
 * Dependency injection: `buildPresalePlan` accepts a `deps` bag
 * (`{ repositories, router }`) that defaults to the real repository module and
 * the configured router (the network-free estimator by default), so property
 * tests pass an in-memory repository fake and never touch a database or the
 * network.
 */

import { planDeliveries } from "./routeService.js";
import { depot as sampleDepot, vehicles as sampleVehicles } from "../data/sampleData.js";
import * as realRepositories from "../db/repositories.js";

/** Default depot reused from the existing sample scenario (Bangkok DC). */
const DEFAULT_DEPOT = { lat: sampleDepot.lat, lng: sampleDepot.lng };

/** Default fleet reused from the sample scenario when none is supplied. */
const DEFAULT_VEHICLES = sampleVehicles.map((v) => ({ ...v }));

/**
 * Message returned (not thrown) when the applied filter matches no customers
 * (Requirement 6.3). Exported so callers/tests reference it without hard-coding
 * a brittle string.
 */
export const PRESALE_MESSAGES = {
  NO_CUSTOMERS_MATCHED: "no customers matched",
};

/**
 * Exact-match filter criteria mapped to the camelCase fields they look up. The
 * filter keys are the workbook column names used in the API/design; the fields
 * are looked up on the joined `presale` object first, then `shop`.
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
 * Look up a filterable field on a joined `{ presale, shop }` item, checking the
 * presale row first and then the shop row. Returns `undefined` when neither row
 * carries the field with a non-null value (so the dimension is ignored for that
 * row).
 */
function lookupField(item, field) {
  const presale = item && item.presale ? item.presale : null;
  const shop = item && item.shop ? item.shop : null;
  if (presale && presale[field] !== undefined && presale[field] !== null) {
    return presale[field];
  }
  if (shop && shop[field] !== undefined && shop[field] !== null) {
    return shop[field];
  }
  return undefined;
}

/**
 * Normalise a date-ish value (Date, ISO string, "YYYY-MM-DD") to a `YYYY-MM-DD`
 * key for `DELIVERY_DATE` comparison, or `null` when it is missing/unparseable.
 */
function toDateKey(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : value.toISOString().slice(0, 10);
  }
  const str = String(value).trim();
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return str;
}

/**
 * Pure Presale filter (Requirement 6). See the module header for the exact
 * matching semantics. Absent/empty criteria match everything, so an empty (or
 * omitted) `filters` returns the input unchanged (identity — Requirement 6.2).
 *
 * @param {Array<{ presale: object, shop: object|null }>} joined
 * @param {object} [filters]
 * @returns {Array<{ presale: object, shop: object|null }>}
 */
export function applyPresaleFilters(joined, filters) {
  if (!Array.isArray(joined)) return [];
  if (!filters) return joined.slice();

  const dateCriterion = filters.DELIVERY_DATE;
  const hasDate = !isAbsent(dateCriterion);
  const dateKey = hasDate ? toDateKey(dateCriterion) : null;

  return joined.filter((item) => {
    // Shop-derived exact-match dimensions: exclude only when the field exists on
    // this row and differs; ignore the dimension when the row lacks the field.
    for (const [filterKey, field] of EXACT_MATCH_FIELDS) {
      const criterion = filters[filterKey];
      if (isAbsent(criterion)) continue;
      const value = lookupField(item, field);
      if (value === undefined) continue;
      if (value !== criterion) return false;
    }

    // DELIVERY_DATE against presale.deliveryDate.
    if (hasDate) {
      const presale = item && item.presale ? item.presale : {};
      const rowKey = toDateKey(presale.deliveryDate);
      if (rowKey == null) return false;
      if (rowKey !== dateKey) return false;
    }

    return true;
  });
}

/**
 * Parse a `"HH:MM"` wall-clock string into minutes-of-day, or `null` when the
 * value is missing/malformed. Mirrors the parsing in `etaService`.
 */
function parseClockMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Whether an ETA falls outside a stop's inclusive `[openTime, closeTime]`
 * window. Returns `false` when the window is missing/unparseable. Uses the
 * ETA's UTC time-of-day, mirroring how `etaService` reports and flags windows
 * (Requirement 7.1).
 */
function isWindowViolation(etaDate, openTime, closeTime) {
  const openMin = parseClockMinutes(openTime);
  const closeMin = parseClockMinutes(closeTime);
  if (openMin == null || closeMin == null) return false;
  const todMin = etaDate.getUTCHours() * 60 + etaDate.getUTCMinutes();
  return todMin < openMin || todMin > closeMin;
}

/**
 * Build an optimized delivery plan from the Presale customer list.
 *
 * @param {object} [input]
 * @param {object} [input.filters]   presale filter criteria (Requirement 6)
 * @param {{lat:number,lng:number}} [input.depot]    defaults to the sample depot
 * @param {Array} [input.vehicles]   defaults to the sample fleet
 * @param {Date} [input.departAt]
 * @param {{ repositories?: object, router?: object }} [input.deps]
 *   Injectable dependencies; default to the real repository module and the
 *   configured router. Property tests pass in-memory fakes here.
 * @returns {Promise<
 *   { plan: object,
 *     unassigned: Array<{ customerCode: string|null, customer: string|null, reason: string }>,
 *     windowViolations: Array<{ customerCode: string, eta: string, openTime: string, closeTime: string }> }
 *   | { message: string }>}
 */
export async function buildPresalePlan({
  filters = {},
  depot = DEFAULT_DEPOT,
  vehicles = DEFAULT_VEHICLES,
  departAt = new Date(),
  deps = {},
} = {}) {
  const repositories = deps.repositories || realRepositories;

  const joined = await repositories.joinPresale();
  const filtered = applyPresaleFilters(joined, filters);

  // The filter (or an empty store) excluded everything (Requirement 6.3).
  if (filtered.length === 0) {
    return { message: PRESALE_MESSAGES.NO_CUSTOMERS_MATCHED };
  }

  // Split into routable orders (resolvable coordinates) vs unassigned customers
  // (Requirement 5.1, 5.5). A customer is unassigned when it has no matching
  // shop OR the matched shop has no resolvable coordinates — regardless of
  // whether Shop_Master data exists for it.
  const orders = [];
  const unassigned = [];

  for (const item of filtered) {
    const presale = (item && item.presale) || {};
    const shop = (item && item.shop) || null;

    if (shop && shop.location) {
      orders.push({
        id: presale.customerCode,
        customer: presale.customerName ?? null,
        demand: presale.demand, // จำนวน Presale (Requirement 5.1)
        location: shop.location,
        serviceTimeMin: shop.serviceTimeMin ?? undefined, // Req 5.4 / 7.2
        openTime: shop.openTime ?? undefined,
        closeTime: shop.closeTime ?? undefined,
        address: shop.address ?? presale.address ?? undefined,
      });
    } else {
      unassigned.push({
        customerCode: presale.customerCode ?? null,
        customer: presale.customerName ?? null,
        reason: shop
          ? "matched shop has no resolvable coordinates"
          : "no matching shop in Shop_Master",
      });
    }
  }

  // Optimize + ETA the routable orders (Requirement 5.2, 5.3). planDeliveries'
  // signature is left intact; when `orders` is empty it simply yields empty
  // routes. `router` defaults to the network-free estimator inside planDeliveries.
  const plan = await planDeliveries({
    depot,
    vehicles,
    orders,
    departAt,
    router: deps.router,
  });

  // Working-time-window check (Requirement 7.1). The plan's returned stops do
  // not carry open/close times, so resolve them from the orders by id, then
  // compare each routed stop's ETA against its window.
  const windowByOrderId = new Map();
  for (const order of orders) {
    if (order.openTime != null && order.closeTime != null) {
      windowByOrderId.set(order.id, {
        openTime: order.openTime,
        closeTime: order.closeTime,
      });
    }
  }

  const windowViolations = [];
  for (const route of plan.routes) {
    for (const stop of route.stops) {
      const window = windowByOrderId.get(stop.orderId);
      if (!window || stop.eta == null) continue;
      const eta = new Date(stop.eta);
      if (isWindowViolation(eta, window.openTime, window.closeTime)) {
        windowViolations.push({
          customerCode: stop.orderId,
          eta: stop.eta,
          openTime: window.openTime,
          closeTime: window.closeTime,
        });
      }
    }
  }

  return { plan, unassigned, windowViolations };
}
