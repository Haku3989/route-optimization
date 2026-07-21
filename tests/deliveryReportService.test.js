import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDeliveryReport,
  actualEtaFromVisit,
  DELIVERY_REPORT_MESSAGES,
  MAX_REPORT_STORES_PER_REQUEST,
} from "../src/services/deliveryReportService.js";

// ---------------------------------------------------------------------------
// Test helpers / fakes (no database, no network)
// ---------------------------------------------------------------------------

function fakeRepos(joined) {
  return { joinHistory: async () => joined };
}

/** Deterministic router fake: constant per-leg metrics, no network. */
const fakeRouter = {
  provider: "test",
  async routeLegs(points) {
    return points.slice(1).map(() => ({ distanceKm: 1, durationMin: 2 }));
  },
};

/** Builds one joined { history, shop } row. */
function row({ customerCode, customerName, storeName = "Store A", dcName = "1801 พัทยา", timeVisit, lat = 13.75, lng = 100.5 }) {
  return {
    history: { customerCode, customerName, storeName, dcName, timeVisit, invoiceDate: "2026-07-19" },
    shop: lat != null ? { location: { lat, lng }, serviceTimeMin: null, openTime: null, closeTime: null } : null,
  };
}

const DAY_FILTERS = { deliveryDateFrom: "2026-07-19", deliveryDateTo: "2026-07-19" };

// ---------------------------------------------------------------------------
// actualEtaFromVisit
// ---------------------------------------------------------------------------

test("actualEtaFromVisit: parses a bare H:MM time anchored to the given day", () => {
  const d = actualEtaFromVisit("7:08", "2026-07-19");
  assert.equal(d.toISOString(), "2026-07-19T07:08:00.000Z");
});

test("actualEtaFromVisit: parses HH:MM:SS", () => {
  const d = actualEtaFromVisit("14:05:30", "2026-07-19");
  assert.equal(d.toISOString(), "2026-07-19T14:05:30.000Z");
});

test("actualEtaFromVisit: a full timestamp is re-anchored to the given day using its own local time-of-day", () => {
  const src = new Date(2020, 0, 1, 9, 30, 0); // local 09:30
  const d = actualEtaFromVisit(src, "2026-07-19");
  assert.equal(d.toISOString(), "2026-07-19T09:30:00.000Z");
});

test("actualEtaFromVisit: unparseable/missing -> null", () => {
  assert.equal(actualEtaFromVisit(null, "2026-07-19"), null);
  assert.equal(actualEtaFromVisit("", "2026-07-19"), null);
  assert.equal(actualEtaFromVisit("not a time", "2026-07-19"), null);
  assert.equal(actualEtaFromVisit("25:99", "2026-07-19"), null);
});

// ---------------------------------------------------------------------------
// computeDeliveryReport guards
// ---------------------------------------------------------------------------

test("computeDeliveryReport: requires a single resolved day", async () => {
  const result = await computeDeliveryReport({
    filters: {},
    deps: { repositories: fakeRepos([]), router: fakeRouter },
  });
  assert.deepEqual(result, { message: DELIVERY_REPORT_MESSAGES.SINGLE_DAY_REQUIRED });
});

test("computeDeliveryReport: a date RANGE (not a single day) is rejected", async () => {
  const result = await computeDeliveryReport({
    filters: { deliveryDateFrom: "2026-07-01", deliveryDateTo: "2026-07-31" },
    deps: { repositories: fakeRepos([]), router: fakeRouter },
  });
  assert.deepEqual(result, { message: DELIVERY_REPORT_MESSAGES.SINGLE_DAY_REQUIRED });
});

test("computeDeliveryReport: no records at all -> NO_RECORDS_SELECTED", async () => {
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos([]), router: fakeRouter },
  });
  assert.deepEqual(result, { message: DELIVERY_REPORT_MESSAGES.NO_RECORDS_SELECTED });
});

test("computeDeliveryReport: a filter that matches nothing (but data exists) -> NO_RECORDS_MATCHED", async () => {
  const joined = [row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "07:00" })];
  const result = await computeDeliveryReport({
    filters: { ...DAY_FILTERS, StoreName: "Nonexistent Store" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });
  assert.deepEqual(result, { message: DELIVERY_REPORT_MESSAGES.NO_RECORDS_MATCHED });
});

test("computeDeliveryReport: more distinct stores than MAX_REPORT_STORES_PER_REQUEST -> guard message, no computation", async () => {
  const joined = Array.from({ length: MAX_REPORT_STORES_PER_REQUEST + 1 }, (_, i) =>
    row({ customerCode: `C${i}`, customerName: `Shop ${i}`, storeName: `Store ${i}`, timeVisit: "07:00" })
  );
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });
  assert.equal(result.message, DELIVERY_REPORT_MESSAGES.tooManyStores(MAX_REPORT_STORES_PER_REQUEST + 1));
});

// ---------------------------------------------------------------------------
// Classification + exclusion behavior
// ---------------------------------------------------------------------------

test("computeDeliveryReport: classifies early/on_time/late against the optimized ETA", async () => {
  // departAt is 04:00 on the day; with the fake router's constant 2-min legs,
  // each successive stop's optimized ETA lands a few minutes after 04:00.
  const joined = [
    row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "03:30" }), // well before -> early
    row({ customerCode: "C2", customerName: "Shop 2", timeVisit: "04:05" }), // near optimized -> on_time
    row({ customerCode: "C3", customerName: "Shop 3", timeVisit: "06:00" }), // well after -> late
  ];
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.equal(result.day, "2026-07-19");
  assert.equal(result.rows.length, 3);
  const byCode = Object.fromEntries(result.rows.map((r) => [r.customerCode, r]));
  assert.equal(byCode.C1.category, "early");
  assert.equal(byCode.C3.category, "late");
  assert.ok(["on_time", "early", "late"].includes(byCode.C2.category));
  assert.equal(result.totals.early + result.totals.onTime + result.totals.late, 3);
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].storeName, "Store A");
});

test("computeDeliveryReport: a customer with no resolvable shop coordinates is excluded, not dropped", async () => {
  const joined = [
    row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "07:00" }),
    row({ customerCode: "C2", customerName: "Shop 2", timeVisit: "07:05", lat: null }), // shop:null
  ];
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].customerCode, "C2");
  assert.equal(result.excluded[0].reason, "no resolvable shop coordinates");
  assert.equal(result.stores[0].unroutableCount, 1);
});

test("computeDeliveryReport: an unparseable time_visit is excluded, not dropped", async () => {
  const joined = [
    row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "07:00" }),
    row({ customerCode: "C2", customerName: "Shop 2", timeVisit: "garbage" }),
  ];
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.equal(result.rows.length, 1);
  const excludedC2 = result.excluded.find((e) => e.customerCode === "C2");
  assert.ok(excludedC2);
  assert.equal(excludedC2.reason, "unparseable time_visit");
  assert.equal(result.stores[0].unparseableTimeCount, 1);
});

test("computeDeliveryReport: a store with zero routable customers is skipped, not fatal to the whole request", async () => {
  const joined = [
    row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "07:00", storeName: "Good Store" }),
    row({ customerCode: "C2", customerName: "Shop 2", timeVisit: "07:00", storeName: "Bad Store", lat: null }),
  ];
  const result = await computeDeliveryReport({
    filters: DAY_FILTERS,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].storeName, "Good Store");
  assert.equal(result.skippedStores.length, 1);
  assert.equal(result.skippedStores[0].storeName, "Bad Store");
  assert.equal(result.skippedStores[0].reason, "no routable customers");
});

test("computeDeliveryReport: a StoreName filter naturally collapses the grouping to exactly one store", async () => {
  const joined = [
    row({ customerCode: "C1", customerName: "Shop 1", timeVisit: "07:00", storeName: "Store A" }),
    row({ customerCode: "C2", customerName: "Shop 2", timeVisit: "07:00", storeName: "Store B" }),
  ];
  const result = await computeDeliveryReport({
    filters: { ...DAY_FILTERS, StoreName: "Store A" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].storeName, "Store A");
  assert.equal(result.rows.length, 1);
});
