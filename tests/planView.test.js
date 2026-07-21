import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  buildFilters,
  fmtEta,
  summarizeComparison,
  summarizePlan,
} from "../public/planView.js";

// ---------------------------------------------------------------------------
// buildFilters — omits empty/whitespace values, keeps + trims provided ones
// ---------------------------------------------------------------------------

test("buildFilters keeps non-empty values (trimmed) and omits empty/whitespace ones", () => {
  const result = buildFilters({
    DC_Name: "Bangkok",
    StoreName: "  Central  ",
    StoreGroup: "",
    "Store Area": "   ",
    CustomerType: null,
    deliveryDateFrom: undefined,
    deliveryDateTo: "2024-01-31",
  });
  assert.deepEqual(result, {
    DC_Name: "Bangkok",
    StoreName: "Central",
    deliveryDateTo: "2024-01-31",
  });
});

test("buildFilters returns an empty object for empty/invalid input", () => {
  assert.deepEqual(buildFilters({}), {});
  assert.deepEqual(buildFilters(null), {});
  assert.deepEqual(buildFilters(undefined), {});
  assert.deepEqual(buildFilters({ a: "", b: "   ", c: null, d: undefined }), {});
});

test("Property: buildFilters output never contains empty/whitespace values and is a subset of inputs", () => {
  const valueArb = fc.oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant(null),
    fc.constant(undefined),
    fc.string(),
  );
  const inputsArb = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), valueArb);

  fc.assert(
    fc.property(inputsArb, (inputs) => {
      const out = buildFilters(inputs);
      for (const key of Object.keys(out)) {
        // Only keys that had non-empty source values survive.
        assert.ok(!isBlank(inputs[key]), `kept a blank key: ${key}`);
        // Value is the trimmed source string, never blank.
        assert.equal(out[key], String(inputs[key]).trim());
        assert.notEqual(out[key].trim(), "");
      }
    }),
    { numRuns: 200 },
  );
});

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

// ---------------------------------------------------------------------------
// fmtEta
// ---------------------------------------------------------------------------

test("fmtEta returns a dash for absent values and echoes unparseable strings", () => {
  assert.equal(fmtEta(null), "--:--");
  assert.equal(fmtEta(undefined), "--:--");
  assert.equal(fmtEta(""), "--:--");
  assert.equal(fmtEta("not-a-date"), "not-a-date");
  assert.equal(typeof fmtEta("2024-01-01T08:30:00Z"), "string");
});

// ---------------------------------------------------------------------------
// summarizeComparison — message case vs table case (+ savedKm/savedPct math)
// ---------------------------------------------------------------------------

test("summarizeComparison handles the { message } guard shape", () => {
  const vm = summarizeComparison({ message: "no records matched" });
  assert.equal(vm.isMessage, true);
  assert.equal(vm.message, "no records matched");
  assert.deepEqual(vm.rows, []);
  assert.equal(vm.savedKm, 0);
  assert.equal(vm.savedPct, 0);
});

test("summarizeComparison builds rows and computes savedKm/savedPct", () => {
  const vm = summarizeComparison({
    customers: [
      {
        customerCode: "C1",
        customer: "Shop 1",
        historicalSeq: 1,
        optimizedSeq: 2,
        historicalEta: "2024-01-01T08:00:00Z",
        optimizedEta: "2024-01-01T09:00:00Z",
      },
      {
        customerCode: "C2",
        customer: "Shop 2",
        historicalSeq: 2,
        optimizedSeq: 1,
        historicalEta: null,
        optimizedEta: null,
      },
    ],
    historicalDistanceKm: 100,
    optimizedDistanceKm: 80,
  });

  assert.equal(vm.isMessage, false);
  assert.equal(vm.rows.length, 2);
  assert.equal(vm.rows[0].customerCode, "C1");
  assert.equal(vm.historicalDistanceKm, 100);
  assert.equal(vm.optimizedDistanceKm, 80);
  assert.equal(vm.savedKm, 20);
  assert.equal(vm.savedPct, 20);
});

test("summarizeComparison passes through per-leg route geometry for both orderings, sanitized", () => {
  const vm = summarizeComparison({
    customers: [],
    historicalDistanceKm: 0,
    optimizedDistanceKm: 0,
    historicalRouteGeometry: [
      [{ lat: 13.7, lng: 100.5 }, { lat: 13.71, lng: 100.51 }],
      null,
    ],
    optimizedRouteGeometry: [
      [{ lat: 13.8, lng: 100.6, extra: "ignored" }],
    ],
  });

  assert.deepEqual(vm.historicalRouteGeometry, [
    [{ lat: 13.7, lng: 100.5 }, { lat: 13.71, lng: 100.51 }],
    null,
  ]);
  assert.deepEqual(vm.optimizedRouteGeometry, [[{ lat: 13.8, lng: 100.6 }]]);
});

test("summarizeComparison: malformed/missing route geometry degrades to [] or per-leg null, never throws", () => {
  const vmMissing = summarizeComparison({ customers: [], historicalDistanceKm: 0, optimizedDistanceKm: 0 });
  assert.deepEqual(vmMissing.historicalRouteGeometry, []);
  assert.deepEqual(vmMissing.optimizedRouteGeometry, []);

  const vmMalformed = summarizeComparison({
    customers: [],
    historicalDistanceKm: 0,
    optimizedDistanceKm: 0,
    historicalRouteGeometry: ["not an array of points", [{ lat: "bad", lng: 1 }], []],
  });
  assert.deepEqual(vmMalformed.historicalRouteGeometry, [null, null, null]);
});

test("summarizeComparison treats a zero historical distance as 0% saved (no divide-by-zero)", () => {
  const vm = summarizeComparison({
    customers: [],
    historicalDistanceKm: 0,
    optimizedDistanceKm: 0,
  });
  assert.equal(vm.savedKm, 0);
  assert.equal(vm.savedPct, 0);
});

test("Property: summarizeComparison savedKm equals historical minus optimized (rounded)", () => {
  const kmArb = fc.double({ min: 0, max: 10000, noNaN: true });
  fc.assert(
    fc.property(kmArb, kmArb, (hist, opt) => {
      const vm = summarizeComparison({
        customers: [],
        historicalDistanceKm: hist,
        optimizedDistanceKm: opt,
      });
      const expectedKm = Math.round((hist - opt) * 100) / 100;
      assert.equal(vm.savedKm, expectedKm);
      const expectedPct =
        hist === 0 ? 0 : Math.round(((hist - opt) / hist) * 100 * 100) / 100;
      assert.equal(vm.savedPct, expectedPct);
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// summarizePlan — message case vs plan case (+ stop flattening)
// ---------------------------------------------------------------------------

test("summarizePlan handles the { message } guard shape", () => {
  const vm = summarizePlan({ message: "no customers matched" });
  assert.equal(vm.isMessage, true);
  assert.equal(vm.message, "no customers matched");
  assert.deepEqual(vm.routes, []);
  assert.deepEqual(vm.stops, []);
  assert.deepEqual(vm.unassigned, []);
  assert.deepEqual(vm.windowViolations, []);
});

test("summarizePlan flattens routes to stops and shapes unassigned + windowViolations", () => {
  const vm = summarizePlan({
    plan: {
      routes: [
        {
          vehicleId: "V1",
          fuelType: "diesel",
          distanceKm: 42.5,
          co2Kg: 10,
          load: 5,
          capacity: 10,
          stops: [
            { orderId: "C1", customer: "Shop 1", demand: 2, sequence: 1, eta: "2024-01-01T08:00:00Z" },
            { orderId: "C2", customer: "Shop 2", demand: 3, sequence: 2, eta: "2024-01-01T08:30:00Z" },
          ],
        },
        {
          vehicleId: "V2",
          fuelType: "ev",
          distanceKm: 0,
          co2Kg: 0,
          load: 0,
          capacity: 10,
          stops: [], // empty route should be dropped
        },
      ],
    },
    unassigned: [{ customerCode: "C9", customer: "Far Shop", reason: "no matching shop in Shop_Master" }],
    windowViolations: [
      { customerCode: "C2", eta: "2024-01-01T08:30:00Z", openTime: "09:00", closeTime: "17:00" },
    ],
  });

  assert.equal(vm.isMessage, false);
  assert.equal(vm.routes.length, 1); // empty route dropped
  assert.equal(vm.routes[0].vehicleId, "V1");
  assert.equal(vm.routes[0].stops.length, 2);
  assert.equal(vm.stops.length, 2); // flattened
  assert.equal(vm.stops[0].customerCode, "C1");
  assert.equal(vm.stops[0].vehicleId, "V1");
  assert.equal(vm.unassigned.length, 1);
  assert.equal(vm.unassigned[0].customerCode, "C9");
  assert.equal(vm.windowViolations.length, 1);
  assert.equal(vm.windowViolations[0].customerCode, "C2");
});

test("summarizePlan carries a stop's location/address through for map plotting", () => {
  const vm = summarizePlan({
    plan: {
      routes: [
        {
          vehicleId: "V1",
          stops: [
            {
              orderId: "C1",
              customer: "Shop 1",
              sequence: 1,
              location: { lat: 13.7, lng: 100.5 },
              address: "123 Main St",
            },
            { orderId: "C2", customer: "Shop 2", sequence: 2 }, // no location/address
          ],
        },
      ],
    },
  });

  assert.deepEqual(vm.routes[0].stops[0].location, { lat: 13.7, lng: 100.5 });
  assert.equal(vm.routes[0].stops[0].address, "123 Main St");
  // Missing location/address are null, not undefined or thrown.
  assert.equal(vm.routes[0].stops[1].location, null);
  assert.equal(vm.routes[0].stops[1].address, null);
  // The flattened stops list carries the same fields through.
  assert.deepEqual(vm.stops[0].location, { lat: 13.7, lng: 100.5 });
});

test("summarizePlan passes through a route's per-leg geometry, sanitized; missing field degrades to []", () => {
  const vm = summarizePlan({
    plan: {
      routes: [
        {
          vehicleId: "V1",
          stops: [{ orderId: "C1", customer: "Shop 1", sequence: 1 }],
          legsGeometry: [
            [{ lat: 13.7, lng: 100.5 }, { lat: 13.71, lng: 100.51 }],
            null,
          ],
        },
        {
          vehicleId: "V2",
          stops: [{ orderId: "C2", customer: "Shop 2", sequence: 1 }],
          // no legsGeometry field at all (older/fake response shape)
        },
      ],
    },
  });

  assert.deepEqual(vm.routes[0].legsGeometry, [
    [{ lat: 13.7, lng: 100.5 }, { lat: 13.71, lng: 100.51 }],
    null,
  ]);
  assert.deepEqual(vm.routes[1].legsGeometry, []);
});

test("summarizePlan drops a non-finite/malformed location instead of passing it through", () => {
  const vm = summarizePlan({
    plan: {
      routes: [
        {
          vehicleId: "V1",
          stops: [{ orderId: "C1", customer: "Shop 1", sequence: 1, location: { lat: "oops", lng: 100.5 } }],
        },
      ],
    },
  });
  assert.equal(vm.routes[0].stops[0].location, null);
});

test("summarizePlan is null-safe for a plan with no routes", () => {
  const vm = summarizePlan({ plan: {}, unassigned: [], windowViolations: [] });
  assert.equal(vm.isMessage, false);
  assert.deepEqual(vm.routes, []);
  assert.deepEqual(vm.stops, []);
});

test("Property: summarizePlan flattened stop count equals the sum of non-empty route stops", () => {
  const stopArb = fc.record({
    orderId: fc.string(),
    customer: fc.string(),
    demand: fc.integer({ min: 0, max: 50 }),
    sequence: fc.integer({ min: 1, max: 30 }),
    eta: fc.constant("2024-01-01T08:00:00Z"),
  });
  const routeArb = fc.record({
    vehicleId: fc.string({ minLength: 1, maxLength: 5 }),
    fuelType: fc.constantFrom("diesel", "ev"),
    distanceKm: fc.double({ min: 0, max: 500, noNaN: true }),
    co2Kg: fc.double({ min: 0, max: 500, noNaN: true }),
    load: fc.integer({ min: 0, max: 50 }),
    capacity: fc.integer({ min: 1, max: 50 }),
    stops: fc.array(stopArb, { maxLength: 6 }),
  });

  fc.assert(
    fc.property(fc.array(routeArb, { maxLength: 6 }), (routes) => {
      const vm = summarizePlan({ plan: { routes }, unassigned: [], windowViolations: [] });
      const expected = routes.reduce((n, r) => n + r.stops.length, 0);
      assert.equal(vm.stops.length, expected);
      // No empty route survives in the routes view-model.
      for (const r of vm.routes) assert.ok(r.stops.length > 0);
    }),
    { numRuns: 150 },
  );
});
