/**
 * Daily delivery on-time report.
 *
 * Compares each History row's ACTUAL recorded visit time (`time_visit`)
 * against the AI-optimized route's computed ETA for that same stop, for one
 * selected day — reporting an early/on-time/late breakdown both per store
 * (summary) and per delivery (detail).
 *
 * "Optimized ETA" requires a real solveCVRP + routing pass, not free SQL
 * aggregation, so this loops over each distinct StoreName in the day's
 * filtered records SEQUENTIALLY (matches `LongdoRouter`'s own
 * rate-limit-friendly sequential design), sharing ONE router instance across
 * the whole request so its circuit breaker persists across stores. Bounded by
 * `MAX_REPORT_STORES_PER_REQUEST`; a request with a `StoreName` filter
 * naturally collapses to exactly one store via the same grouping, so there is
 * no separate single-store code path.
 *
 * No live per-request geocoding: `distinctResolvableCustomers` is called with
 * `geocoder = null` (already handles this cleanly). Unlike `compareHistory`,
 * which geocodes live for one store, this can loop over many stores per
 * request — live geocoding at that scale would be far more network calls
 * than any existing flow issues. `backfillService.js` is the intended path
 * for improving shop-coordinate coverage over time, not this report.
 *
 * Every customer in the day's filtered records ends up in exactly one of:
 * `rows[]` (classified), `excluded[]` (a reason, per customer), or a
 * `skippedStores[]` entry (a reason, for the whole store) — never silently
 * dropped.
 *
 * Dependency injection: accepts a `deps` bag (`{ repositories, router }`)
 * defaulting to the real modules, mirroring every other service in this app.
 */

import { solveCVRP } from "../optimizer/vrp.js";
import { ETA_CONFIG, defaultDepartAt } from "./etaService.js";
import { createRouter } from "../routing/router.js";
import { classifyDeviation, ON_TIME_TOLERANCE_MIN } from "./onTimeClassification.js";
import {
  applyHistoryFilters,
  hasAnyFilter,
  singleDayKey,
  depotFromFilters,
  distinctResolvableCustomers,
  toOrder,
  etasByCode,
  MAX_COMPARISON_CUSTOMERS,
  DEFAULT_DEPOT,
} from "./historyService.js";
import * as realRepositories from "../db/repositories.js";

/** Upper bound on distinct stores processed in one whole-day report request
 * (each store is its own solveCVRP + routing pass, run sequentially). */
export const MAX_REPORT_STORES_PER_REQUEST = 20;

export const DELIVERY_REPORT_MESSAGES = {
  SINGLE_DAY_REQUIRED:
    "select a single day for the daily delivery report (deliveryDateFrom and deliveryDateTo must be the same day)",
  NO_RECORDS_SELECTED: "no records selected",
  NO_RECORDS_MATCHED: "no records matched",
  tooManyStores: (n) =>
    `Too many stores (${n}) for one report. Apply a filter (DC_Name, StoreGroup, or StoreName) ` +
    `to narrow to ${MAX_REPORT_STORES_PER_REQUEST} or fewer.`,
};

const BARE_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turn a raw `time_visit` value into a real Date anchored to `dayKey`, so its
 * UTC time-of-day is directly comparable to `optimizedEta` (built via
 * `etaService.defaultDepartAt`'s same UTC-as-local convention).
 *
 * @param {*} timeVisitRaw
 * @param {string} dayKey `"YYYY-MM-DD"`
 * @returns {Date|null}
 */
export function actualEtaFromVisit(timeVisitRaw, dayKey) {
  if (timeVisitRaw == null || timeVisitRaw === "") return null;

  if (timeVisitRaw instanceof Date) {
    if (Number.isNaN(timeVisitRaw.getTime())) return null;
    return anchorToDay(timeVisitRaw.getHours(), timeVisitRaw.getMinutes(), timeVisitRaw.getSeconds(), dayKey);
  }

  const s = String(timeVisitRaw).trim();
  const bare = s.match(BARE_TIME_RE);
  if (bare) {
    const hours = Number(bare[1]);
    const minutes = Number(bare[2]);
    const seconds = Number(bare[3] ?? 0);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    return anchorToDay(hours, minutes, seconds, dayKey);
  }

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return anchorToDay(parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(), dayKey);
}

function anchorToDay(hours, minutes, seconds, dayKey) {
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return new Date(`${dayKey}T${hh}:${mm}:${ss}.000Z`);
}

function pct(count, total) {
  return total > 0 ? round((count / total) * 100) : 0;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function emptyStoreCounters() {
  return { early: 0, onTime: 0, late: 0, deviationSum: 0, deviationCount: 0 };
}

/**
 * Compute one store's on-time comparison. Returns `{ storeSummary }` on
 * success, or `{ skipped: { reason } }` when the store can't be processed at
 * all (too many customers, or none routable) — mutates `rows`/`excluded` in
 * place for the successful case.
 */
async function computeStoreReport({ storeName, storeRecords, dayKey, departAt, router, rows, excluded }) {
  const dcName = storeRecords[0]?.history?.dcName ?? null;
  const distinctCustomerCodes = new Set(storeRecords.map((r) => r?.history?.customerCode).filter(Boolean));

  const resolvable = await distinctResolvableCustomers(storeRecords, null, MAX_COMPARISON_CUSTOMERS);

  if (resolvable.length === 0) {
    return { skipped: { storeName, dcName, recordCount: distinctCustomerCodes.size, reason: "no routable customers" } };
  }
  if (resolvable.length > MAX_COMPARISON_CUSTOMERS) {
    return { skipped: { storeName, dcName, recordCount: distinctCustomerCodes.size, reason: "too many customers" } };
  }

  const resolvableCodes = new Set(resolvable.map((c) => c.customerCode));
  for (const code of distinctCustomerCodes) {
    if (!resolvableCodes.has(code)) {
      const rec = storeRecords.find((r) => r?.history?.customerCode === code);
      excluded.push({
        storeName,
        dcName,
        customerCode: code,
        customer: rec?.history?.customerName ?? null,
        reason: "no resolvable shop coordinates",
      });
    }
  }

  const depot = depotFromFilters({ StoreName: storeName }) ?? DEFAULT_DEPOT;
  const orders = resolvable.map(toOrder);
  const notionalVehicle = { id: `RPT-${storeName}`, capacity: orders.length, speedKmh: ETA_CONFIG.DEFAULT_SPEED_KMH };
  const { routes } = solveCVRP({ depot, vehicles: [notionalVehicle], orders });
  const optimizedStops = routes.flatMap((r) => r.stops);
  const etaByCustomerCode = await etasByCode(router, depot, optimizedStops, departAt, ETA_CONFIG.DEFAULT_SPEED_KMH);

  const counters = emptyStoreCounters();
  let unparseableTimeCount = 0;

  for (const customer of resolvable) {
    const optimizedEtaIso = etaByCustomerCode.get(customer.customerCode) ?? null;
    const actualEtaDate = actualEtaFromVisit(customer.timeVisitRaw, dayKey);

    if (!actualEtaDate) {
      unparseableTimeCount += 1;
      excluded.push({
        storeName,
        dcName,
        customerCode: customer.customerCode,
        customer: customer.customer,
        reason: "unparseable time_visit",
      });
      continue;
    }
    if (!optimizedEtaIso) {
      excluded.push({
        storeName,
        dcName,
        customerCode: customer.customerCode,
        customer: customer.customer,
        reason: "no optimized ETA computed",
      });
      continue;
    }

    const deviationMin = round((actualEtaDate.getTime() - new Date(optimizedEtaIso).getTime()) / 60000);
    const category = classifyDeviation(deviationMin);

    rows.push({
      storeName,
      dcName,
      customerCode: customer.customerCode,
      customer: customer.customer,
      actualEta: actualEtaDate.toISOString(),
      optimizedEta: optimizedEtaIso,
      deviationMin,
      category,
    });

    if (category === "early") counters.early += 1;
    else if (category === "late") counters.late += 1;
    else if (category === "on_time") counters.onTime += 1;
    counters.deviationSum += deviationMin;
    counters.deviationCount += 1;
  }

  const routableDeliveries = counters.early + counters.onTime + counters.late;
  const storeSummary = {
    storeName,
    dcName,
    totalRecords: distinctCustomerCodes.size,
    routableDeliveries,
    unroutableCount: distinctCustomerCodes.size - resolvable.length,
    unparseableTimeCount,
    early: counters.early,
    onTime: counters.onTime,
    late: counters.late,
    earlyPct: pct(counters.early, routableDeliveries),
    onTimePct: pct(counters.onTime, routableDeliveries),
    latePct: pct(counters.late, routableDeliveries),
    avgDeviationMin: counters.deviationCount > 0 ? round(counters.deviationSum / counters.deviationCount) : null,
  };
  return { storeSummary, counters };
}

/**
 * Compute the daily delivery on-time report for a single day (and optional
 * DC_Name/StoreName/StoreGroup/Store Area/CustomerType filters).
 *
 * @param {object} [input]
 * @param {object} [input.filters] must resolve to exactly one day via
 *   `deliveryDateFrom`/`deliveryDateTo` (the dashboard's day-picker always
 *   sends them equal)
 * @param {{ repositories?: object, router?: object }} [input.deps]
 * @returns {Promise<
 *   { day:string, toleranceMin:number, stores:Array, totals:object,
 *     rows:Array, excluded:Array, skippedStores:Array }
 *   | { message: string }>}
 */
export async function computeDeliveryReport({ filters = {}, deps = {} } = {}) {
  const repositories = deps.repositories || realRepositories;
  const router = deps.router || createRouter();

  const dayKey = singleDayKey(filters);
  if (!dayKey) {
    return { message: DELIVERY_REPORT_MESSAGES.SINGLE_DAY_REQUIRED };
  }
  const departAt = defaultDepartAt(dayKey);

  const joined = await repositories.joinHistory();
  const records = applyHistoryFilters(joined, filters);

  if (records.length === 0) {
    if (hasAnyFilter(filters) && Array.isArray(joined) && joined.length > 0) {
      return { message: DELIVERY_REPORT_MESSAGES.NO_RECORDS_MATCHED };
    }
    return { message: DELIVERY_REPORT_MESSAGES.NO_RECORDS_SELECTED };
  }

  const byStore = new Map();
  for (const item of records) {
    const storeName = item?.history?.storeName ?? "(no store name)";
    if (!byStore.has(storeName)) byStore.set(storeName, []);
    byStore.get(storeName).push(item);
  }

  if (byStore.size > MAX_REPORT_STORES_PER_REQUEST) {
    return { message: DELIVERY_REPORT_MESSAGES.tooManyStores(byStore.size) };
  }

  const stores = [];
  const rows = [];
  const excluded = [];
  const skippedStores = [];
  const totals = emptyStoreCounters();
  let totalRecords = 0;
  let unroutableCount = 0;
  let unparseableTimeCount = 0;

  for (const [storeName, storeRecords] of byStore) {
    const result = await computeStoreReport({ storeName, storeRecords, dayKey, departAt, router, rows, excluded });
    if (result.skipped) {
      skippedStores.push(result.skipped);
      continue;
    }
    stores.push(result.storeSummary);
    totalRecords += result.storeSummary.totalRecords;
    unroutableCount += result.storeSummary.unroutableCount;
    unparseableTimeCount += result.storeSummary.unparseableTimeCount;
    totals.early += result.counters.early;
    totals.onTime += result.counters.onTime;
    totals.late += result.counters.late;
    totals.deviationSum += result.counters.deviationSum;
    totals.deviationCount += result.counters.deviationCount;
  }

  const routableDeliveries = totals.early + totals.onTime + totals.late;

  return {
    day: dayKey,
    toleranceMin: ON_TIME_TOLERANCE_MIN,
    stores,
    totals: {
      totalRecords,
      routableDeliveries,
      unroutableCount,
      unparseableTimeCount,
      early: totals.early,
      onTime: totals.onTime,
      late: totals.late,
      earlyPct: pct(totals.early, routableDeliveries),
      onTimePct: pct(totals.onTime, routableDeliveries),
      latePct: pct(totals.late, routableDeliveries),
      avgDeviationMin: totals.deviationCount > 0 ? round(totals.deviationSum / totals.deviationCount) : null,
    },
    rows,
    excluded,
    skippedStores,
  };
}
