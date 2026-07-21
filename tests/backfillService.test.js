import test from "node:test";
import assert from "node:assert/strict";

import {
  runBackfill,
  triggerBackfillIfReady,
  getBackfillStatus,
  isBackfillRunning,
} from "../src/services/backfillService.js";

// ---------------------------------------------------------------------------
// In-memory repository fake (no database, no network).
// ---------------------------------------------------------------------------

function fakeRepositories({ historyOnly = [], unresolvedShops = [], hasAllTypes = true } = {}) {
  const upsertCalls = [];
  return {
    findHistoryOnlyCustomers: async () => historyOnly,
    findUnresolvedShops: async () => unresolvedShops,
    hasAllWorkbookTypes: async () => hasAllTypes,
    upsertShops: async (records) => {
      upsertCalls.push(records);
      return records.length;
    },
    _upsertCalls: upsertCalls,
  };
}

test("runBackfill: geocodes each UNIQUE query once, even when many customers share it", async () => {
  const historyOnly = Array.from({ length: 50 }, (_, i) => ({
    customerCode: `C${i}`,
    geocodeQuery: "Store A", // all 50 share the same store
    customerName: `Shop ${i}`,
  }));

  let geocodeCalls = 0;
  const geocoder = {
    async geocode(q) {
      geocodeCalls += 1;
      return { lat: 13.7, lng: 100.5 };
    },
  };

  const repositories = fakeRepositories({ historyOnly });
  const result = await runBackfill({ repositories, geocoder });

  assert.equal(geocodeCalls, 1, "50 customers sharing one query must geocode exactly once");
  assert.equal(result.state, "done");
  assert.equal(result.queriesTotal, 1);
  assert.equal(result.customersTotal, 50);
  assert.equal(result.customersResolved, 50);
  assert.equal(result.customersFailed, 0);

  // All 50 customer records were persisted with the shared location.
  const allRecords = repositories._upsertCalls.flat();
  assert.equal(allRecords.length, 50);
  for (const r of allRecords) {
    assert.deepEqual(r.location, { lat: 13.7, lng: 100.5 });
    assert.equal(r.coordSource, "geocoded");
  }
});

test("runBackfill: a query the geocoder can't resolve is persisted as 'unresolved', not skipped", async () => {
  // Regression: an unpersisted failure would make findHistoryOnlyCustomers()
  // return the SAME customer on every future upload, re-geocoding forever.
  const historyOnly = [
    { customerCode: "C1", geocodeQuery: "Unknown Place", customerName: "Shop 1" },
  ];
  const geocoder = { async geocode() { return null; } };

  const repositories = fakeRepositories({ historyOnly });
  const result = await runBackfill({ repositories, geocoder });

  assert.equal(result.customersResolved, 0);
  assert.equal(result.customersFailed, 1);

  const [record] = repositories._upsertCalls.flat();
  assert.equal(record.customerCode, "C1");
  assert.equal(record.location, null);
  assert.equal(record.coordSource, "unresolved");
  // shopName must be the QUERY, not customerName — see the next test for why.
  assert.equal(record.shopName, "Unknown Place");
});

test("runBackfill: unresolved shopName stays the shared QUERY, not the per-customer name (dedup regression)", async () => {
  // Regression: if the persisted 'unresolved' shop's shopName were the
  // per-customer name instead of the shared query, findUnresolvedShops()'s
  // retry pass (which uses shop_name AS its geocode query) would lose the
  // dedup entirely — a real run went from 685 unique queries to ~37,000
  // because of exactly this. Every customer sharing one failed query must
  // persist with the SAME shopName.
  const historyOnly = [
    { customerCode: "C1", geocodeQuery: "Store A", customerName: "Alice's Shop" },
    { customerCode: "C2", geocodeQuery: "Store A", customerName: "Bob's Shop" },
  ];
  const geocoder = { async geocode() { return null; } };

  const repositories = fakeRepositories({ historyOnly });
  await runBackfill({ repositories, geocoder });

  const records = repositories._upsertCalls.flat();
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.shopName, "Store A", "unresolved shopName must be the shared query, not the customer name");
  }
});

test("runBackfill: existing unresolved shops carry through serviceTime/open/close unchanged", async () => {
  const unresolvedShops = [
    {
      customerCode: "S1",
      geocodeQuery: "Store B",
      shopName: "Store B",
      serviceTimeMin: 15,
      openTime: "08:00",
      closeTime: "18:00",
    },
  ];
  const geocoder = { async geocode() { return { lat: 14.0, lng: 100.2 }; } };

  const repositories = fakeRepositories({ unresolvedShops });
  await runBackfill({ repositories, geocoder });

  const [record] = repositories._upsertCalls.flat();
  assert.equal(record.customerCode, "S1");
  assert.equal(record.serviceTimeMin, 15);
  assert.equal(record.openTime, "08:00");
  assert.equal(record.closeTime, "18:00");
  assert.deepEqual(record.location, { lat: 14.0, lng: 100.2 });
});

test("runBackfill: a customer with no usable query is never geocoded, but is still persisted as 'unresolved'", async () => {
  const historyOnly = [{ customerCode: "C1", geocodeQuery: null, customerName: null }];
  let geocodeCalls = 0;
  const geocoder = { async geocode() { geocodeCalls += 1; return { lat: 1, lng: 1 }; } };

  const repositories = fakeRepositories({ historyOnly });
  const result = await runBackfill({ repositories, geocoder });

  assert.equal(geocodeCalls, 0, "no query string -> never worth a geocode call");
  assert.equal(result.customersTotal, 1);
  assert.equal(result.customersFailed, 1);

  const [record] = repositories._upsertCalls.flat();
  assert.equal(record.customerCode, "C1");
  assert.equal(record.coordSource, "unresolved");
});

test("runBackfill: a second run does NOT re-geocode a customer that already failed once", async () => {
  // Stateful fake modeling the real DB relationship: a history-only customer
  // becomes an 'unresolved' shop row after a failed attempt, so a SECOND
  // findHistoryOnlyCustomers() call must no longer return it (it now has a
  // shop row) — and findUnresolvedShops() picks it up instead.
  const historyRows = [{ customerCode: "C1", geocodeQuery: "Unknown Place", customerName: "Shop 1" }];
  const shops = new Map(); // customerCode -> shop record

  const repositories = {
    findHistoryOnlyCustomers: async () =>
      historyRows.filter((h) => !shops.has(h.customerCode)),
    findUnresolvedShops: async () =>
      [...shops.values()]
        .filter((s) => s.location == null)
        .map((s) => ({
          customerCode: s.customerCode,
          geocodeQuery: s.shopName,
          shopName: s.shopName,
          serviceTimeMin: null,
          openTime: null,
          closeTime: null,
        })),
    upsertShops: async (records) => {
      for (const r of records) shops.set(r.customerCode, r);
      return records.length;
    },
  };

  let geocodeCalls = 0;
  const failingGeocoder = { async geocode() { geocodeCalls += 1; return null; } };

  const first = await runBackfill({ repositories, geocoder: failingGeocoder });
  assert.equal(first.customersFailed, 1);
  assert.equal(geocodeCalls, 1);
  assert.equal(shops.get("C1").coordSource, "unresolved");

  // Second run: the customer no longer comes from findHistoryOnlyCustomers()
  // (it has a shop row now) — it's retried via findUnresolvedShops() instead,
  // and still costs exactly one more geocode call, not zero AND not a
  // duplicate/uncounted retry.
  const second = await runBackfill({ repositories, geocoder: failingGeocoder });
  assert.equal(geocodeCalls, 2, "retried exactly once more via the unresolved-shops path");
  assert.equal(second.customersFailed, 1);
});

test("runBackfill: a mid-run failure is captured in status.error, not thrown", async () => {
  const repositories = {
    findHistoryOnlyCustomers: async () => {
      throw new Error("db exploded");
    },
    findUnresolvedShops: async () => [],
    upsertShops: async () => 0,
  };

  const result = await runBackfill({ repositories, geocoder: { geocode: async () => null } });
  assert.equal(result.state, "error");
  assert.match(result.error, /db exploded/);
});

test("triggerBackfillIfReady: does not start when not all 3 workbook types are present", async () => {
  const repositories = fakeRepositories({ hasAllTypes: false });
  const started = await triggerBackfillIfReady({ repositories, geocoder: { geocode: async () => null } });
  assert.equal(started, false);
  assert.equal(isBackfillRunning(), false);
});

test("triggerBackfillIfReady: starts when all 3 types are present, without blocking the caller", async () => {
  // A geocoder that resolves after a short delay, so the job is still
  // in-flight right after triggerBackfillIfReady returns (proving it did
  // NOT wait for the job to finish), then finishes on its own shortly after.
  const geocoder = {
    geocode: () => new Promise((resolve) => setTimeout(() => resolve({ lat: 1, lng: 1 }), 20)),
  };
  const repositories = fakeRepositories({
    hasAllTypes: true,
    historyOnly: [{ customerCode: "C1", geocodeQuery: "Store Z", customerName: "Shop Z" }],
  });

  const started = await triggerBackfillIfReady({ repositories, geocoder });
  assert.equal(started, true);
  // Fire-and-forget: the job is running but triggerBackfillIfReady already returned.
  assert.equal(isBackfillRunning(), true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getBackfillStatus().state, "done");
});

test("triggerBackfillIfReady: a second call while one is running is a no-op", async () => {
  const geocoder = {
    geocode: () => new Promise((resolve) => setTimeout(() => resolve({ lat: 1, lng: 1 }), 20)),
  };
  const repositories = fakeRepositories({
    hasAllTypes: true,
    historyOnly: [{ customerCode: "C1", geocodeQuery: "Store Y", customerName: "Shop Y" }],
  });

  await triggerBackfillIfReady({ repositories, geocoder });
  assert.equal(isBackfillRunning(), true);

  const secondStarted = await triggerBackfillIfReady({ repositories, geocoder });
  assert.equal(secondStarted, false, "must not start a second overlapping run");

  await new Promise((r) => setTimeout(r, 40));
});
