import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  compareHistory,
  applyHistoryFilters,
  getHistoryOverview,
  getHistoryDates,
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
// Regression: a real Postgres DATE column comes back from `pg` as a JS Date
// constructed in the server's LOCAL timezone (e.g. `new Date(2026, 6, 17)`
// for a stored '2026-07-17'), NOT UTC midnight. A single-day filter
// (deliveryDateFrom === deliveryDateTo, exactly what the dashboard's day
// picker sends) must still match that row regardless of the process's local
// timezone — reading UTC getters here previously shifted the date by the
// server's UTC offset and excluded almost everything (caught via a live
// Bangkok/UTC+7 run: a day filter on a 79-customer store returned zero rows).
// ---------------------------------------------------------------------------

test("applyHistoryFilters: a single-day filter matches a real pg-style local-midnight Date, in any timezone", () => {
  // Exactly how node-postgres's default DATE parser builds the JS Date for a
  // stored '2026-07-17': local-time components, not UTC.
  const pgStyleLocalMidnight = new Date(2026, 6, 17);
  // The day-picker sends the SAME calendar day as a plain string for both bounds.
  const dayString = "2026-07-17";

  const joined = [
    { history: { customerCode: "C1", invoiceDate: pgStyleLocalMidnight } },
  ];

  const result = applyHistoryFilters(joined, {
    deliveryDateFrom: dayString,
    deliveryDateTo: dayString,
  });

  assert.equal(result.length, 1, "the row's own calendar day must match a same-day filter");
});

test("applyHistoryFilters: a single-day filter excludes a real pg-style Date for an ADJACENT day", () => {
  const pgStyleLocalMidnight = new Date(2026, 6, 16); // one day earlier
  const dayString = "2026-07-17";

  const joined = [
    { history: { customerCode: "C1", invoiceDate: pgStyleLocalMidnight } },
  ];

  const result = applyHistoryFilters(joined, {
    deliveryDateFrom: dayString,
    deliveryDateTo: dayString,
  });

  assert.equal(result.length, 0);
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

test(
  "compareHistory: matched rows with no resolvable shop coordinates report NO_ROUTABLE_CUSTOMERS, not NO_RECORDS_SELECTED",
  async () => {
    // The filter matches real rows, but neither customer's shop resolved to a
    // location (e.g. no Shop_Master upload, or unmatched/unresolved coords).
    // This must NOT be reported the same way as "you selected nothing".
    const joined = [
      {
        history: {
          customerCode: "C1",
          customerName: "Shop 1",
          timeVisit: "2026-01-01T08:00:00Z",
          invoiceDate: "2026-01-01",
          dcName: "DC_A",
        },
        shop: null, // no matching Shop_Master row
      },
      {
        history: {
          customerCode: "C2",
          customerName: "Shop 2",
          timeVisit: "2026-01-01T09:00:00Z",
          invoiceDate: "2026-01-01",
          dcName: "DC_A",
        },
        shop: { location: null, coordSource: "unresolved" }, // shop exists, coords didn't resolve
      },
    ];

    const result = await compareHistory({
      filters: { DC_Name: "DC_A" },
      deps: { repositories: fakeRepos(joined), router: fakeRouter },
    });

    assert.deepEqual(result, { message: HISTORY_MESSAGES.NO_ROUTABLE_CUSTOMERS });
  }
);

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

// ---------------------------------------------------------------------------
// Geocoding fallback (Req 2.1-2.3 reused): a history row whose Customer_Code
// is not found in Shop_Master (or whose master coordinates never resolved)
// falls back to geocoding the row's own store/customer name instead of being
// dropped from the comparison.
// ---------------------------------------------------------------------------

test("compareHistory: geocodes a customer's location when not found in Shop_Master", async () => {
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        storeName: "Shop 1 Branch",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: null, // no matching Shop_Master row
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

  const geocodeCalls = [];
  const fakeGeocoder = {
    async geocode(query) {
      geocodeCalls.push(query);
      return { lat: 13.9, lng: 100.6 };
    },
  };

  const result = await compareHistory({
    depot: DEPOT,
    deps: { repositories: fakeRepos(joined), router: fakeRouter, geocoder: fakeGeocoder },
  });

  assert.ok(result.customers, `expected a comparison, got ${JSON.stringify(result)}`);
  assert.equal(result.customers.length, 2);
  // Geocoded using the row's own customerName (preferred over storeName —
  // an internal DC/unit code that rarely resolves via Longdo).
  assert.deepEqual(geocodeCalls, ["Shop 1"]);
  const c1 = result.customers.find((r) => r.customerCode === "C1");
  assert.ok(c1);
});

test("compareHistory: still excludes a customer when geocoding also fails to resolve", async () => {
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: null,
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

  const noopGeocoder = { async geocode() { return null; } };

  const result = await compareHistory({
    depot: DEPOT,
    deps: { repositories: fakeRepos(joined), router: fakeRouter, geocoder: noopGeocoder },
  });

  // Only C2 is routable, so the comparison still needs two customers.
  assert.deepEqual(result, { message: HISTORY_MESSAGES.NEEDS_TWO_CUSTOMERS });
});

test(
  "compareHistory: skips geocoding entirely once the master-only count already exceeds the cap",
  async () => {
    // Regression: an unfiltered request over a large dataset can have far more
    // unresolved rows than the comparison cap. Geocoding every one of them
    // would mean thousands of real, sequential network calls for a result
    // that gets rejected anyway — the geocoder must never be called in that
    // case. MAX_COMPARISON_CUSTOMERS is 150, so 151 MASTER-resolvable rows
    // alone already exceeds it, before any unresolved row is even considered.
    const resolvable = Array.from({ length: 151 }, (_, i) => ({
      history: {
        customerCode: `R${i}`,
        customerName: `Shop ${i}`,
        timeVisit: `2026-01-01T${String(9 + (i % 10)).padStart(2, "0")}:00:00Z`,
        invoiceDate: "2026-01-01",
      },
      shop: { location: { lat: 13.7 + i * 0.001, lng: 100.5 }, coordSource: "master" },
    }));
    const unresolved = {
      history: {
        customerCode: "UNRESOLVED",
        customerName: "Should never be geocoded",
        storeName: "Some Store",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
      },
      shop: null,
    };

    let geocodeCalls = 0;
    const spyGeocoder = {
      async geocode() {
        geocodeCalls += 1;
        return { lat: 13.9, lng: 100.6 };
      },
    };

    const result = await compareHistory({
      depot: DEPOT,
      deps: {
        repositories: fakeRepos([...resolvable, unresolved]),
        router: fakeRouter,
        geocoder: spyGeocoder,
      },
    });

    assert.equal(geocodeCalls, 0, "geocoder must not be called once already over the cap");
    assert.ok(result.message, `expected a guard message, got ${JSON.stringify(result).slice(0, 200)}`);
    assert.match(result.message, /Too many customers \(151\)/);
  }
);

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
  // fakeRouter never supplies a `geometry` field, so both orderings degrade
  // to an all-null per-leg array (not undefined, not a thrown error) — the
  // frontend's straight-line fallback signal.
  assert.ok(Array.isArray(result.historicalRouteGeometry));
  assert.ok(result.historicalRouteGeometry.every((g) => g === null));
  assert.ok(Array.isArray(result.optimizedRouteGeometry));
  assert.ok(result.optimizedRouteGeometry.every((g) => g === null));
});

test("compareHistory: surfaces each ordering's real per-leg route geometry when the router supplies it", async () => {
  const joined = [
    {
      history: { customerCode: "C1", customerName: "Shop 1", timeVisit: "2026-01-01T09:00:00Z", invoiceDate: "2026-01-01" },
      shop: { location: { lat: 13.72, lng: 100.53 }, coordSource: "master" },
    },
    {
      history: { customerCode: "C2", customerName: "Shop 2", timeVisit: "2026-01-01T08:00:00Z", invoiceDate: "2026-01-01" },
      shop: { location: { lat: 13.8, lng: 100.55 }, coordSource: "master" },
    },
  ];

  let call = 0;
  const geometryRouter = {
    provider: "test",
    async routeLegs(points, opts) {
      assert.equal(opts.withGeometry, true, "compareHistory must request geometry for both rendered orderings");
      call += 1;
      return points.slice(1).map((_, i) => ({
        distanceKm: 1,
        durationMin: 2,
        // Distinct geometry per call so the test can tell historical vs optimized apart.
        geometry: i === 0 ? [{ lat: 13.7 + call, lng: 100.5 }, { lat: 13.71 + call, lng: 100.51 }] : null,
      }));
    },
  };

  const result = await compareHistory({
    depot: DEPOT,
    deps: { repositories: fakeRepos(joined), router: geometryRouter },
  });

  assert.equal(call, 2, "one routeLegs() call per ordering (historical, optimized)");
  assert.ok(Array.isArray(result.historicalRouteGeometry));
  assert.ok(Array.isArray(result.optimizedRouteGeometry));
  // First leg of each ordering carries real geometry; later legs (i>0) are null.
  assert.ok(Array.isArray(result.historicalRouteGeometry[0]));
  assert.ok(Array.isArray(result.optimizedRouteGeometry[0]));
  assert.equal(result.historicalRouteGeometry[1], null);
  assert.equal(result.optimizedRouteGeometry[1], null);
  // The two orderings' geometry are genuinely distinct (not the same array reused).
  assert.notDeepEqual(result.historicalRouteGeometry[0], result.optimizedRouteGeometry[0]);
});

// ---------------------------------------------------------------------------
// Regression (Req 3.1): TIME_VISIT is often a bare time-of-day like "7:08".
// It must (a) not break ingestion/ordering, and (b) sort chronologically by
// time-of-day rather than lexicographically ("13:45" must come after "7:08").
// ---------------------------------------------------------------------------

test("historical order sorts bare time-of-day TIME_VISIT values chronologically", async () => {
  const mkRow = (code, timeVisit, lat, lng) => ({
    history: {
      customerCode: code,
      customerName: `Shop ${code}`,
      timeVisit,
      invoiceDate: "2026-01-10",
    },
    shop: { location: { lat, lng }, coordSource: "master" },
  });

  const joined = [
    mkRow("C1", "13:45", 13.72, 100.53),
    mkRow("C2", "7:08", 13.8, 100.55),
    mkRow("C3", "9:30", 13.66, 100.6),
  ];

  const result = await compareHistory({
    depot: DEPOT,
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers, `expected a comparison, got ${JSON.stringify(result)}`);
  const order = [...result.customers]
    .sort((a, b) => a.historicalSeq - b.historicalSeq)
    .map((r) => r.customerCode);
  // Chronological by time-of-day: 7:08 -> 9:30 -> 13:45.
  assert.deepEqual(order, ["C2", "C3", "C1"]);
});

// ---------------------------------------------------------------------------
// Depot resolution — when no explicit `depot` is passed, compareHistory
// derives it from the filter's StoreName (preferred) or DC_Name via each
// string's leading 4-digit DC code (see data/dcList.js). Uses real DC codes
// (1202 บางบัวทอง, 1103 พระยาสุเรนทร์).
// ---------------------------------------------------------------------------

/** Two resolvable customers, reused by the depot-resolution tests. */
function twoResolvableHistoryRows() {
  return [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
        dcName: "1202 บางบัวทอง",
        storeName: "120210 หน่วย ลิบ บางบัวทอง",
      },
      shop: { location: { lat: 13.72, lng: 100.53 }, coordSource: "master" },
    },
    {
      history: {
        customerCode: "C2",
        customerName: "Shop 2",
        timeVisit: "2026-01-01T08:00:00Z",
        invoiceDate: "2026-01-01",
        dcName: "1202 บางบัวทอง",
        storeName: "120210 หน่วย ลิบ บางบัวทอง",
      },
      shop: { location: { lat: 13.8, lng: 100.55 }, coordSource: "master" },
    },
  ];
}

test("compareHistory: with no explicit depot, derives it from filters.StoreName's DC code", async () => {
  const joined = twoResolvableHistoryRows();

  const result = await compareHistory({
    filters: { StoreName: "120210 หน่วย ลิบ บางบัวทอง" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers, `expected a comparison, got ${JSON.stringify(result)}`);
  // DC 1202 บางบัวทอง's coordinates.
  assert.equal(Math.round(result.depot.lat * 1e6), Math.round(13.929295 * 1e6));
  assert.equal(Math.round(result.depot.lng * 1e6), Math.round(100.433144 * 1e6));
});

test("compareHistory: with no explicit depot and no StoreName, falls back to filters.DC_Name's DC code", async () => {
  // Rows carry a matching dcName (so the DC_Name filter actually selects them)
  // but no storeName, so the depot can only be derived via the DC_Name path.
  const joined = [
    {
      history: {
        customerCode: "C1",
        customerName: "Shop 1",
        timeVisit: "2026-01-01T09:00:00Z",
        invoiceDate: "2026-01-01",
        dcName: "1103 พระยาสุเรนทร์",
      },
      shop: { location: { lat: 13.72, lng: 100.53 }, coordSource: "master" },
    },
    {
      history: {
        customerCode: "C2",
        customerName: "Shop 2",
        timeVisit: "2026-01-01T08:00:00Z",
        invoiceDate: "2026-01-01",
        dcName: "1103 พระยาสุเรนทร์",
      },
      shop: { location: { lat: 13.8, lng: 100.55 }, coordSource: "master" },
    },
  ];

  const result = await compareHistory({
    filters: { DC_Name: "1103 พระยาสุเรนทร์" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers, `expected a comparison, got ${JSON.stringify(result)}`);
  // DC 1103 พระยาสุเรนทร์'s coordinates.
  assert.equal(Math.round(result.depot.lat * 1e6), Math.round(13.82031 * 1e6));
  assert.equal(Math.round(result.depot.lng * 1e6), Math.round(100.6999429 * 1e6));
});

test("compareHistory: an explicit depot always wins over a filter-derived one", async () => {
  const joined = twoResolvableHistoryRows();
  const explicitDepot = { lat: 1, lng: 1 };

  const result = await compareHistory({
    depot: explicitDepot,
    filters: { StoreName: "120210 หน่วย ลิบ บางบัวทอง" },
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers);
  assert.deepEqual(result.depot, explicitDepot);
});

test("compareHistory: falls back to the sample depot when no depot is given and no filter resolves a DC", async () => {
  const joined = twoResolvableHistoryRows();

  const result = await compareHistory({
    filters: {}, // no StoreName / DC_Name criterion at all
    deps: { repositories: fakeRepos(joined), router: fakeRouter },
  });

  assert.ok(result.customers);
  // Matches src/data/sampleData.js's depot (the module-level DEFAULT_DEPOT).
  assert.deepEqual(result.depot, { lat: 13.7563, lng: 100.5018 });
});

// ---------------------------------------------------------------------------
// getHistoryOverview — thin passthrough to repositories.historyOverview()
// ---------------------------------------------------------------------------

test("getHistoryOverview: delegates to repositories.historyOverview()", async () => {
  const overview = {
    byDc: [{ dcName: "DC_A", visits: 10, customers: 4 }],
    byStore: [{ storeName: "Store 1", dcName: "DC_A", visits: 10, customers: 4 }],
  };
  const repositories = { historyOverview: async () => overview };

  const result = await getHistoryOverview({ repositories });
  assert.deepEqual(result, overview);
});

// ---------------------------------------------------------------------------
// getHistoryDates — thin passthrough to repositories.distinctHistoryDates()
// ---------------------------------------------------------------------------

test("getHistoryDates: delegates to repositories.distinctHistoryDates() with the given filters", async () => {
  let receivedFilters = null;
  const repositories = {
    distinctHistoryDates: async (filters) => {
      receivedFilters = filters;
      return ["2026-01-10", "2026-01-11"];
    },
  };

  const result = await getHistoryDates({ storeName: "Store A" }, { repositories });
  assert.deepEqual(result, ["2026-01-10", "2026-01-11"]);
  assert.deepEqual(receivedFilters, { storeName: "Store A" });
});
