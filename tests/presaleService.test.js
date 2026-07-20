import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  buildPresalePlan,
  applyPresaleFilters,
  PRESALE_MESSAGES,
} from "../src/services/presaleService.js";

// ---------------------------------------------------------------------------
// Test helpers / fakes (no database, no network)
// ---------------------------------------------------------------------------

const DEPOT = { lat: 13.75, lng: 100.5 };

/** In-memory repository fake exposing only joinPresale(). */
function fakeRepos(joined) {
  return { joinPresale: async () => joined };
}

const arbLat = fc.double({ min: 13.5, max: 14.0, noNaN: true });
const arbLng = fc.double({ min: 100.3, max: 100.8, noNaN: true });

/**
 * Arbitrary set of RESOLVABLE presale customers (each has a shop with a
 * location). Codes are assigned by index so the customer set is distinct
 * (the order id is the customer code).
 */
const arbResolvableCustomers = fc
  .array(
    fc.record({
      name: fc.string(),
      demand: fc.integer({ min: 1, max: 50 }),
      lat: arbLat,
      lng: arbLng,
    }),
    { minLength: 1, maxLength: 8 }
  )
  .map((list) => list.map((c, i) => ({ ...c, code: `C${i}` })));

/** Build joined `{ presale, shop }` rows (all resolvable) from customers. */
function buildResolvableJoined(customers) {
  return customers.map((c) => ({
    presale: {
      id: c.code,
      customerCode: c.code,
      customerName: c.name,
      deliveryDate: "2026-02-01",
      demand: c.demand,
    },
    shop: {
      location: { lat: c.lat, lng: c.lng },
      serviceTimeMin: null,
      openTime: null,
      closeTime: null,
      coordSource: "master",
    },
  }));
}

// ---------------------------------------------------------------------------
// Property 10 (order-shape half) (task 11.2) — Validates: Requirements 5.1
// ---------------------------------------------------------------------------

test("Property 10: resolvable joined presale entries produce well-formed orders", async () => {
  // Feature: excel-route-planning, Property 10: Presale code parsing round-trips and produces well-formed orders
  await fc.assert(
    fc.asyncProperty(arbResolvableCustomers, async (customers) => {
      const joined = buildResolvableJoined(customers);
      // One vehicle with capacity for the whole set so every resolvable entry
      // becomes a routed stop we can inspect for shape + demand.
      const capacity = customers.reduce((sum, c) => sum + c.demand, 0);
      const result = await buildPresalePlan({
        depot: DEPOT,
        vehicles: [{ id: "BIG", capacity, fuelType: "diesel", speedKmh: 35 }],
        deps: { repositories: fakeRepos(joined) },
      });

      assert.ok(result.plan, `expected a plan, got ${JSON.stringify(result)}`);
      assert.equal(result.unassigned.length, 0);

      const stopById = new Map(
        result.plan.routes.flatMap((r) => r.stops).map((s) => [s.orderId, s])
      );

      for (const c of customers) {
        const stop = stopById.get(c.code);
        assert.ok(stop, `customer ${c.code} should be routed`);
        // { id, customer, demand, location:{lat,lng} } with demand == จำนวน Presale.
        assert.equal(stop.orderId, c.code);
        assert.equal(stop.customer, c.name);
        assert.equal(stop.demand, c.demand);
        assert.deepEqual(stop.location, { lat: c.lat, lng: c.lng });
        assert.equal(typeof stop.location.lat, "number");
        assert.equal(typeof stop.location.lng, "number");
      }
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 11 (capacity) (task 11.3) — Validates: Requirements 5.2
// ---------------------------------------------------------------------------

const arbFleet = fc
  .array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 4 })
  .map((caps) =>
    caps.map((capacity, i) => ({
      id: `V${i}`,
      capacity,
      fuelType: "diesel",
      speedKmh: 35,
    }))
  );

test("Property 11: presale routing respects vehicle capacity", async () => {
  // Feature: excel-route-planning, Property 11: Presale routing respects vehicle capacity
  await fc.assert(
    fc.asyncProperty(arbResolvableCustomers, arbFleet, async (customers, vehicles) => {
      const joined = buildResolvableJoined(customers);
      const result = await buildPresalePlan({
        depot: DEPOT,
        vehicles,
        deps: { repositories: fakeRepos(joined) },
      });

      assert.ok(result.plan);
      for (const route of result.plan.routes) {
        assert.ok(
          route.load <= route.capacity,
          `route load ${route.load} exceeds capacity ${route.capacity}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 12 (assigned-stop ETA) (task 11.4) — Validates: Requirements 5.3
// ---------------------------------------------------------------------------

test("Property 12: every assigned presale stop has an ETA", async () => {
  // Feature: excel-route-planning, Property 12: Every assigned presale stop has an ETA
  await fc.assert(
    fc.asyncProperty(arbResolvableCustomers, async (customers) => {
      const joined = buildResolvableJoined(customers);
      const capacity = customers.reduce((sum, c) => sum + c.demand, 0);
      const result = await buildPresalePlan({
        depot: DEPOT,
        vehicles: [{ id: "BIG", capacity, fuelType: "diesel", speedKmh: 35 }],
        deps: { repositories: fakeRepos(joined) },
      });

      assert.ok(result.plan);
      let routedStops = 0;
      for (const route of result.plan.routes) {
        for (const stop of route.stops) {
          routedStops++;
          assert.notEqual(stop.eta, null, "every routed stop must have an ETA");
          assert.equal(typeof stop.eta, "string");
        }
      }
      // Sanity: the whole (non-empty) resolvable set was routed.
      assert.equal(routedStops, customers.length);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 13 (unassigned) (task 11.5) — Validates: Requirements 5.5
// ---------------------------------------------------------------------------

// A customer that is either resolvable, unresolvable-with-shop (shop present but
// no location), or unresolvable-without-shop (no matching shop row at all).
const arbMixedCustomers = fc
  .array(
    fc.record({
      name: fc.string(),
      demand: fc.integer({ min: 1, max: 30 }),
      lat: arbLat,
      lng: arbLng,
      kind: fc.constantFrom("resolvable", "shopNoCoords", "noShop"),
    }),
    { minLength: 1, maxLength: 10 }
  )
  .map((list) => list.map((c, i) => ({ ...c, code: `C${i}` })));

test("Property 13: unresolvable presale customers are unassigned with a reason and never routed", async () => {
  // Feature: excel-route-planning, Property 13: Unresolvable presale customers are unassigned with a reason and never routed
  await fc.assert(
    fc.asyncProperty(arbMixedCustomers, async (customers) => {
      const joined = customers.map((c) => {
        const presale = {
          id: c.code,
          customerCode: c.code,
          customerName: c.name,
          deliveryDate: "2026-02-01",
          demand: c.demand,
        };
        if (c.kind === "resolvable") {
          return { presale, shop: { location: { lat: c.lat, lng: c.lng }, coordSource: "master" } };
        }
        if (c.kind === "shopNoCoords") {
          return { presale, shop: { location: null, coordSource: "unresolved" } };
        }
        return { presale, shop: null };
      });

      // Ample capacity so any resolvable customer is actually routed.
      const capacity = customers.reduce((sum, c) => sum + c.demand, 0) + 1;
      const result = await buildPresalePlan({
        depot: DEPOT,
        vehicles: [{ id: "BIG", capacity, fuelType: "diesel", speedKmh: 35 }],
        deps: { repositories: fakeRepos(joined) },
      });

      assert.ok(result.plan);
      const routedIds = new Set(
        result.plan.routes.flatMap((r) => r.stops.map((s) => s.orderId))
      );
      const unassignedByCode = new Map(
        result.unassigned.map((u) => [u.customerCode, u])
      );

      for (const c of customers) {
        if (c.kind === "resolvable") continue;
        const u = unassignedByCode.get(c.code);
        assert.ok(u, `unresolvable ${c.code} (${c.kind}) must be unassigned`);
        assert.ok(
          typeof u.reason === "string" && u.reason.length > 0,
          "unassigned entry must carry a reason"
        );
        assert.ok(!routedIds.has(c.code), `unresolvable ${c.code} must never be routed`);
      }
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 14 (presale filtering) (task 11.6) — Validates: Requirements 6.1, 6.2
// ---------------------------------------------------------------------------

const DC = ["DC_A", "DC_B", "DC_C"];
const STORE = ["S1", "S2"];
const GROUP = ["G1", "G2"];
const AREA = ["Central", "East"];
const TYPE = ["KA", "TT"];
const DATES = ["2026-02-01", "2026-02-02", "2026-02-03"];

// Filterable dimensions live on the presale row (present via fc.option, absent
// as undefined). deliveryDate is present for most rows, absent for some.
const arbPresaleRow = fc.record({
  code: fc.string({ minLength: 1, maxLength: 5 }),
  dcName: fc.option(fc.constantFrom(...DC), { nil: undefined }),
  storeName: fc.option(fc.constantFrom(...STORE), { nil: undefined }),
  storeGroup: fc.option(fc.constantFrom(...GROUP), { nil: undefined }),
  storeArea: fc.option(fc.constantFrom(...AREA), { nil: undefined }),
  customerType: fc.option(fc.constantFrom(...TYPE), { nil: undefined }),
  deliveryDate: fc.option(fc.constantFrom(...DATES), { nil: undefined }),
});

const arbPresaleFilters = fc.record({
  DC_Name: fc.option(fc.constantFrom(...DC), { nil: undefined }),
  StoreName: fc.option(fc.constantFrom(...STORE), { nil: undefined }),
  StoreGroup: fc.option(fc.constantFrom(...GROUP), { nil: undefined }),
  "Store Area": fc.option(fc.constantFrom(...AREA), { nil: undefined }),
  CustomerType: fc.option(fc.constantFrom(...TYPE), { nil: undefined }),
  DELIVERY_DATE: fc.option(fc.constantFrom(...DATES), { nil: undefined }),
});

const FILTER_FIELDS = [
  ["DC_Name", "dcName"],
  ["StoreName", "storeName"],
  ["StoreGroup", "storeGroup"],
  ["Store Area", "storeArea"],
  ["CustomerType", "customerType"],
];

function toDateKey(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? String(value).trim() : parsed.toISOString().slice(0, 10);
}

/** Independent oracle mirroring the documented filtering semantics. */
function oracleMatch(item, filters) {
  const presale = item.presale || {};
  const lookup = (field) =>
    presale[field] !== undefined && presale[field] !== null ? presale[field] : undefined;

  for (const [key, field] of FILTER_FIELDS) {
    const criterion = filters[key];
    if (criterion === undefined || criterion === null || criterion === "") continue;
    const value = lookup(field);
    if (value === undefined) continue;
    if (value !== criterion) return false;
  }

  const dc = filters.DELIVERY_DATE;
  if (!(dc === undefined || dc === null || dc === "")) {
    const rowKey = toDateKey(presale.deliveryDate);
    if (rowKey == null) return false;
    if (rowKey !== toDateKey(dc)) return false;
  }
  return true;
}

test("Property 14: presale filtering is sound and empty-filter is identity", () => {
  // Feature: excel-route-planning, Property 14: Presale filtering is sound and empty-filter is identity
  fc.assert(
    fc.property(fc.array(arbPresaleRow, { maxLength: 30 }), arbPresaleFilters, (rows, filters) => {
      const joined = rows.map((r) => ({
        presale: {
          customerCode: r.code,
          customerName: r.code,
          deliveryDate: r.deliveryDate,
          demand: 1,
          dcName: r.dcName,
          storeName: r.storeName,
          storeGroup: r.storeGroup,
          storeArea: r.storeArea,
          customerType: r.customerType,
        },
        shop: null,
      }));

      const result = applyPresaleFilters(joined, filters);

      // Soundness: every returned row satisfies every supplied criterion whose
      // field is present on the row (and the date criterion when supplied).
      for (const item of result) {
        const p = item.presale;
        for (const [key, field] of FILTER_FIELDS) {
          const criterion = filters[key];
          if (criterion === undefined) continue;
          if (p[field] !== undefined && p[field] !== null) {
            assert.equal(p[field], criterion);
          }
        }
        if (filters.DELIVERY_DATE !== undefined) {
          assert.equal(toDateKey(p.deliveryDate), toDateKey(filters.DELIVERY_DATE));
        }
      }

      // Completeness: matches the independent oracle exactly (same refs/order).
      const expected = joined.filter((item) => oracleMatch(item, filters));
      assert.deepEqual(result, expected);

      // Identity: no criteria returns every record.
      assert.deepEqual(applyPresaleFilters(joined, {}), joined);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Example test (task 11.7) — Validates: Requirement 6.3
// ---------------------------------------------------------------------------

test("buildPresalePlan: a filter matching no customers returns the no-match message (Req 6.3)", async () => {
  const joined = [
    {
      presale: {
        id: "C1",
        customerCode: "C1",
        customerName: "Shop 1",
        deliveryDate: "2026-02-01",
        demand: 10,
      },
      shop: { location: { lat: 13.72, lng: 100.53 }, coordSource: "master" },
    },
    {
      presale: {
        id: "C2",
        customerCode: "C2",
        customerName: "Shop 2",
        deliveryDate: "2026-02-01",
        demand: 12,
      },
      shop: { location: { lat: 13.8, lng: 100.55 }, coordSource: "master" },
    },
  ];

  const result = await buildPresalePlan({
    filters: { DELIVERY_DATE: "2099-12-31" },
    deps: { repositories: fakeRepos(joined) },
  });

  assert.deepEqual(result, { message: PRESALE_MESSAGES.NO_CUSTOMERS_MATCHED });
});
