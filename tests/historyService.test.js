import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  compareHistory,
  applyHistoryFilters,
  HISTORY_MESSAGES,
} from "../src/services/historyService.js";
import { routeDistanceKm } from "../src/optimizer/vrp.js";

// ---------------------------------------------------------------------------
// Test helpers / fakes (no database, no network)
// ---------------------------------------------------------------------------

const DEPOT = { lat: 13.75, lng: 100.5 };

/** In-memory repository fake exposing only joinHistory(). */
function fakeRepos(joined) {
  return { joinHistory: async () => joined };
}

/**
 * Deterministic router fake: constant per-leg metrics. ETAs and route distances
 * used by the properties do not depend on the concrete leg values, so a fixed
 * fake keeps the tests hermetic (never hits the network).
 */
const fakeRouter = {
  provider: "test",
  async routeLegs(points) {
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      legs.push({ distanceKm: 1, durationMin: 2 });
    }
    return legs;
  },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function range1(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// Generators for the ordering / coverage / distance properties (6, 7, 8)
// ---------------------------------------------------------------------------

const arbLat = fc.double({ min: 13.5, max: 14.0, noNaN: true });
const arbLng = fc.double({ min: 100.3, max: 100.8, noNaN: true });

// A customer with a location and 1-3 history visits (varying TIME_VISIT). Codes
// are assigned by index so the set is guaranteed distinct.
const arbCustomers = fc
  .array(
    fc.record({
      name: fc.string(),
      lat: arbLat,
      lng: arbLng,
      times: fc.array(fc.integer({ min: 0, max: 2_000_000_000 }), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    { minLength: 2, maxLength: 6 }
  )
  .map((list) => list.map((c, i) => ({ ...c, code: `C${i}` })));

/** Build joined `{ history, shop }` rows (all resolvable) from customers. */
function buildJoined(customers) {
  const joined = [];
  for (const c of customers) {
    for (const t of c.times) {
      joined.push({
        history: {
          customerCode: c.code,
          customerName: c.name,
          timeVisit: new Date(t).toISOString(),
          invoiceDate: null,
          dcName: null,
          storeName: null,
          storeGroup: null,
          storeArea: null,
          customerType: null,
        },
        shop: {
          location: { lat: c.lat, lng: c.lng },
          serviceTimeMin: null,
          openTime: null,
          closeTime: null,
          coordSource: "master",
        },
      });
    }
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Property 6 (task 10.2) — Validates: Requirements 3.1
// ---------------------------------------------------------------------------

test("Property 6: historical order is the timestamp ordering", async () => {
  // Feature: excel-route-planning, Property 6: Historical order is the timestamp ordering
  await fc.assert(
    fc.asyncProperty(arbCustomers, async (customers) => {
      const joined = buildJoined(customers);
      const result = await compareHistory({
        depot: DEPOT,
        deps: { repositories: fakeRepos(joined), router: fakeRouter },
      });

      assert.ok(result.customers, `expected a comparison, got ${JSON.stringify(result)}`);

      const rows = [...result.customers].sort((a, b) => a.historicalSeq - b.historicalSeq);

      // Permutation of exactly the distinct customer set.
      assert.deepEqual(
        new Set(rows.map((r) => r.customerCode)),
        new Set(customers.map((c) => c.code))
      );
      // Contiguous 1..N sequence positions.
      assert.deepEqual(
        rows.map((r) => r.historicalSeq),
        rows.map((_, i) => i + 1)
      );
      // Non-decreasing by the earliest TIME_VISIT per customer.
      const earliest = new Map(customers.map((c) => [c.code, Math.min(...c.times)]));
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          earliest.get(rows[i].customerCode) >= earliest.get(rows[i - 1].customerCode),
          "historical order must be non-decreasing by TIME_VISIT"
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 7 (task 10.3) — Validates: Requirements 3.2, 3.3, 3.4
// ---------------------------------------------------------------------------

test("Property 7: history comparison covers the full customer set in both orderings", async () => {
  // Feature: excel-route-planning, Property 7: History comparison covers the full customer set in both orderings
  await fc.assert(
    fc.asyncProperty(arbCustomers, async (customers) => {
      const joined = buildJoined(customers);
      const result = await compareHistory({
        depot: DEPOT,
        deps: { repositories: fakeRepos(joined), router: fakeRouter },
      });

      assert.ok(result.customers);
      const n = customers.length;
      assert.equal(result.customers.length, n);

      // Every customer reports both sequence positions and both ETAs.
      for (const row of result.customers) {
        assert.ok(Number.isInteger(row.historicalSeq));
        assert.ok(Number.isInteger(row.optimizedSeq));
        assert.notEqual(row.historicalEta, null);
        assert.notEqual(row.optimizedEta, null);
      }

      // Optimized set equals historical set; both orderings are permutations 1..N.
      const codes = new Set(customers.map((c) => c.code));
      assert.deepEqual(new Set(result.customers.map((r) => r.customerCode)), codes);
      assert.deepEqual(
        new Set(result.customers.map((r) => r.historicalSeq)),
        new Set(range1(n))
      );
      assert.deepEqual(
        new Set(result.customers.map((r) => r.optimizedSeq)),
        new Set(range1(n))
      );
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 8 (task 10.4) — Validates: Requirements 3.5
// ---------------------------------------------------------------------------

test("Property 8: reported comparison distances equal the route distances of each ordering", async () => {
  // Feature: excel-route-planning, Property 8: Reported comparison distances equal the route distances of each ordering
  await fc.assert(
    fc.asyncProperty(arbCustomers, async (customers) => {
      const joined = buildJoined(customers);
      const result = await compareHistory({
        depot: DEPOT,
        deps: { repositories: fakeRepos(joined), router: fakeRouter },
      });

      assert.ok(result.customers);

      const locByCode = new Map(
        customers.map((c) => [c.code, { lat: c.lat, lng: c.lng }])
      );
      const histStops = [...result.customers]
        .sort((a, b) => a.historicalSeq - b.historicalSeq)
        .map((r) => ({ location: locByCode.get(r.customerCode) }));
      const optStops = [...result.customers]
        .sort((a, b) => a.optimizedSeq - b.optimizedSeq)
        .map((r) => ({ location: locByCode.get(r.customerCode) }));

      assert.equal(
        result.historicalDistanceKm,
        round2(routeDistanceKm(DEPOT, histStops))
      );
      assert.equal(
        result.optimizedDistanceKm,
        round2(routeDistanceKm(DEPOT, optStops))
      );
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 9 (task 10.5) — Validates: Requirements 4.1, 4.2, 4.3
// ---------------------------------------------------------------------------

const DC = ["DC_A", "DC_B", "DC_C"];
const STORE = ["S1", "S2"];
const GROUP = ["G1", "G2"];
const AREA = ["Central", "East"];
const TYPE = ["KA", "TT"];
const DATE_BASE = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

function toDateStr(dayOffset) {
  return new Date(DATE_BASE + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

const arbHistoryRow = fc.record({
  customerCode: fc.string({ minLength: 1, maxLength: 5 }),
  dcName: fc.constantFrom(...DC),
  storeName: fc.constantFrom(...STORE),
  storeGroup: fc.constantFrom(...GROUP),
  storeArea: fc.constantFrom(...AREA),
  customerType: fc.constantFrom(...TYPE),
  dayOffset: fc.integer({ min: 0, max: 20 }),
});

const arbFilters = fc.record({
  DC_Name: fc.option(fc.constantFrom(...DC), { nil: undefined }),
  StoreName: fc.option(fc.constantFrom(...STORE), { nil: undefined }),
  StoreGroup: fc.option(fc.constantFrom(...GROUP), { nil: undefined }),
  "Store Area": fc.option(fc.constantFrom(...AREA), { nil: undefined }),
  CustomerType: fc.option(fc.constantFrom(...TYPE), { nil: undefined }),
  deliveryDateFrom: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
  deliveryDateTo: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
});

test("Property 9: history filtering is sound and empty-filter is identity", () => {
  // Feature: excel-route-planning, Property 9: History filtering is sound and empty-filter is identity
  fc.assert(
    fc.property(
      fc.array(arbHistoryRow, { maxLength: 30 }),
      arbFilters,
      (rows, rawFilters) => {
        const joined = rows.map((r) => ({
          history: { ...r, invoiceDate: toDateStr(r.dayOffset) },
          shop: null,
        }));

        const filters = { ...rawFilters };
        if (filters.deliveryDateFrom !== undefined) {
          filters.deliveryDateFrom = toDateStr(filters.deliveryDateFrom);
        }
        if (filters.deliveryDateTo !== undefined) {
          filters.deliveryDateTo = toDateStr(filters.deliveryDateTo);
        }

        const result = applyHistoryFilters(joined, filters);

        // Soundness: every returned record satisfies every supplied criterion.
        for (const item of result) {
          const h = item.history;
          if (filters.DC_Name !== undefined) assert.equal(h.dcName, filters.DC_Name);
          if (filters.StoreName !== undefined) assert.equal(h.storeName, filters.StoreName);
          if (filters.StoreGroup !== undefined) assert.equal(h.storeGroup, filters.StoreGroup);
          if (filters["Store Area"] !== undefined) assert.equal(h.storeArea, filters["Store Area"]);
          if (filters.CustomerType !== undefined) assert.equal(h.customerType, filters.CustomerType);
          const invMs = Date.parse(h.invoiceDate);
          if (filters.deliveryDateFrom !== undefined) {
            assert.ok(invMs >= Date.parse(filters.deliveryDateFrom));
          }
          if (filters.deliveryDateTo !== undefined) {
            assert.ok(invMs <= Date.parse(filters.deliveryDateTo));
          }
        }

        // Completeness: matches an independent oracle exactly (same order/refs).
        const expected = joined.filter((item) => {
          const h = item.history;
          if (filters.DC_Name !== undefined && h.dcName !== filters.DC_Name) return false;
          if (filters.StoreName !== undefined && h.storeName !== filters.StoreName) return false;
          if (filters.StoreGroup !== undefined && h.storeGroup !== filters.StoreGroup) return false;
          if (filters["Store Area"] !== undefined && h.storeArea !== filters["Store Area"]) return false;
          if (filters.CustomerType !== undefined && h.customerType !== filters.CustomerType) return false;
          const invMs = Date.parse(h.invoiceDate);
          if (filters.deliveryDateFrom !== undefined && invMs < Date.parse(filters.deliveryDateFrom)) return false;
          if (filters.deliveryDateTo !== undefined && invMs > Date.parse(filters.deliveryDateTo)) return false;
          return true;
        });
        assert.deepEqual(result, expected);

        // Identity: no criteria returns every record.
        assert.deepEqual(applyHistoryFilters(joined, {}), joined);
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Example tests (task 10.6) — count / no-match messages
// ---------------------------------------------------------------------------

test("compareHistory: zero records returns 'no records selected' (Req 3.7)", async () => {
  const result = await compareHistory({
    deps: { repositories: fakeRepos([]), router: fakeRouter },
  });
  assert.deepEqual(result, { message: HISTORY_MESSAGES.NO_RECORDS_SELECTED });
});

test("compareHistory: a single customer requires at least two (Req 3.6)", async () => {
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T08:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: {
        location: { lat: 13.7, lng: 100.5 },
        serviceTimeMin: null,
        openTime: null,
        closeTime: null,
        coordSource: "master",
      },
    },
  ];
  const result = await compareHistory({
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });
  assert.deepEqual(result, { message: HISTORY_MESSAGES.NEEDS_TWO_CUSTOMERS });
});

test("compareHistory: a filter matching nothing returns 'no records matched' (Req 4.4)", async () => {
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T08:00:00Z",
        invoiceDate: "2026-01-01",
        dcName: "DC_A",
      },
      shop: { location: { lat: 13.7, lng: 100.5 }, coordSource: "master" },
    },
    {
      history: {
        customerCode: "C2",
        customerName: "Shop 2",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-02",
        dcName: "DC_A",
      },
      shop: { location: { lat: 13.8, lng: 100.6 }, coordSource: "master" },
    },
  ];
  const result = await compareHistory({
    filters: { DC_Name: "DC_ZZZ" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });
  assert.deepEqual(result, { message: HISTORY_MESSAGES.NO_RECORDS_MATCHED });
});

test("compareHistory: two resolvable customers produce a full comparison", async () => {
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: { location: { lat: 13.72, lng: 100.53 }, coordSource: "master" },
    },
    {
      history: {
        customerCode: "C2",
        customerName: "Shop 2",
        timeVisit: "2026-01-01T08:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: { location: { lat: 13.8, lng: 100.55 }, coordSource: "master" },
    },
  ];
  const result = await compareHistory({
    depot: DEPOT,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers);
  assert.equal(result.customers.length, 2);
  // C2 has the earlier TIME_VISIT, so it leads the historical order.
  const rowsByHist = [...result.customers].sort((a, b) => a.historicalSeq - b.historicalSeq);
  assert.equal(rowsByHist[0].customerCode, "C2");
  assert.equal(typeof result.historicalDistanceKm, "number");
  assert.equal(typeof result.optimizedDistanceKm, "number");
  for (const row of result.customers) {
    assert.ok(row.historicalEta);
    assert.ok(row.optimizedEta);
  }
});
