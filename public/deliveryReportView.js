/**
 * Delivery report view — PURE view logic for the daily delivery on-time
 * report page, mirroring `planView.js`'s pattern: no DOM access and no
 * network access at import time, so it runs identically in the browser
 * (`deliveryReport.js`) and under `node:test` (`tests/deliveryReportView.test.js`).
 *
 * Mirrors POST /api/delivery-report/compute -> deliveryReportService.computeDeliveryReport:
 *   { day, toleranceMin,
 *     stores:[{ storeName, dcName, totalRecords, routableDeliveries, unroutableCount,
 *       unparseableTimeCount, early, onTime, late, earlyPct, onTimePct, latePct, avgDeviationMin }],
 *     totals: { /* same shape, no storeName * / },
 *     rows:[{ storeName, dcName, customerCode, customer, actualEta, optimizedEta, deviationMin, category }],
 *     excluded:[{ storeName, dcName, customerCode, customer, reason }],
 *     skippedStores:[{ storeName, dcName, recordCount, reason }] } | { message }
 */

function round(n) {
  return Math.round(n * 100) / 100;
}

function mapStoreSummary(s) {
  return {
    storeName: s.storeName ?? null,
    dcName: s.dcName ?? null,
    totalRecords: Number(s.totalRecords) || 0,
    routableDeliveries: Number(s.routableDeliveries) || 0,
    unroutableCount: Number(s.unroutableCount) || 0,
    unparseableTimeCount: Number(s.unparseableTimeCount) || 0,
    early: Number(s.early) || 0,
    onTime: Number(s.onTime) || 0,
    late: Number(s.late) || 0,
    earlyPct: Number(s.earlyPct) || 0,
    onTimePct: Number(s.onTimePct) || 0,
    latePct: Number(s.latePct) || 0,
    avgDeviationMin: Number.isFinite(s.avgDeviationMin) ? round(s.avgDeviationMin) : null,
  };
}

function mapRow(r) {
  return {
    storeName: r.storeName ?? null,
    dcName: r.dcName ?? null,
    customerCode: r.customerCode ?? null,
    customer: r.customer ?? null,
    actualEta: r.actualEta ?? null,
    optimizedEta: r.optimizedEta ?? null,
    deviationMin: Number.isFinite(r.deviationMin) ? round(r.deviationMin) : null,
    category: r.category ?? null,
  };
}

function mapExcluded(e) {
  return {
    storeName: e.storeName ?? null,
    dcName: e.dcName ?? null,
    customerCode: e.customerCode ?? null,
    customer: e.customer ?? null,
    reason: e.reason ?? null,
  };
}

function mapSkipped(s) {
  return {
    storeName: s.storeName ?? null,
    dcName: s.dcName ?? null,
    recordCount: Number(s.recordCount) || 0,
    reason: s.reason ?? null,
  };
}

/**
 * Shape a delivery-report API response into a view-model. Handles the
 * `{ message }` guard shape (single-day required, no records, too many
 * stores, etc.) and the full report shape.
 *
 * @param {object} result the parsed JSON body from /api/delivery-report/compute
 * @returns {{ isMessage: boolean, message?: string, day: string|null,
 *   toleranceMin: number|null, stores: Array<object>, totals: object|null,
 *   rows: Array<object>, excluded: Array<object>, skippedStores: Array<object> }}
 */
export function summarizeDeliveryReport(result) {
  if (!result || typeof result !== "object" || typeof result.message === "string") {
    return {
      isMessage: true,
      message: result && result.message ? result.message : "No result.",
      day: null,
      toleranceMin: null,
      stores: [],
      totals: null,
      rows: [],
      excluded: [],
      skippedStores: [],
    };
  }

  return {
    isMessage: false,
    day: result.day ?? null,
    toleranceMin: Number.isFinite(result.toleranceMin) ? result.toleranceMin : null,
    stores: Array.isArray(result.stores) ? result.stores.map(mapStoreSummary) : [],
    totals: result.totals && typeof result.totals === "object" ? mapStoreSummary(result.totals) : null,
    rows: Array.isArray(result.rows) ? result.rows.map(mapRow) : [],
    excluded: Array.isArray(result.excluded) ? result.excluded.map(mapExcluded) : [],
    skippedStores: Array.isArray(result.skippedStores) ? result.skippedStores.map(mapSkipped) : [],
  };
}
