import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildMapsUrl,
  renderStopList,
  shouldShowEmptyMessage,
  renderRoute,
  EMPTY_MESSAGE,
  FALLBACK_MESSAGE,
} from "../public/driverView.js";

// ---------------------------------------------------------------------------
// Generators (curated character sets keep strings free of lone surrogates so
// encodeURIComponent / URL round-trips are well-defined)
// ---------------------------------------------------------------------------

const latArb = fc.double({ min: -90, max: 90, noNaN: true });
const lngArb = fc.double({ min: -180, max: 180, noNaN: true });

// Address chars: Latin, digits, spaces, common punctuation, and a few Thai
// glyphs — all safe for encodeURIComponent and a URL round-trip.
const ADDR_CHARS =
  "ABCDEFabcdef0123456789 ,.-/#()กขคงจรานสมชยทองพลาซ่า".split("");
const addressArb = fc
  .array(fc.constantFrom(...ADDR_CHARS), { minLength: 1, maxLength: 30 })
  .map((chars) => chars.join("").trim())
  .filter((s) => s.length > 0);

const NAME_CHARS = "ABCDEFabcdef0123456789 กขคงรานสมชย".split("");
const customerArb = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(""));

const etaArb = fc
  .date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-01-01T00:00:00Z") })
  .map((d) => d.toISOString());

// A stop that always carries a customer name and an ETA (Property 17 domain).
const stopArb = fc.record({
  sequence: fc.integer({ min: 0, max: 60 }),
  customer: customerArb,
  eta: etaArb,
  completed: fc.boolean(),
  location: fc.option(fc.record({ lat: latArb, lng: lngArb }), { nil: null }),
  address: fc.option(addressArb, { nil: null }),
});

const routeArb = fc.record({
  stops: fc.array(stopArb, { maxLength: 12 }),
  currentSequence: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
});

// ---------------------------------------------------------------------------
// Property 17 (task 14.2) — Validates: Requirements 8.1
// ---------------------------------------------------------------------------

test("Property 17: driver view renders stops in non-decreasing sequence with name and ETA", () => {
  // Feature: excel-route-planning, Property 17: Driver view renders stops in optimized sequence with name and ETA
  fc.assert(
    fc.property(routeArb, (route) => {
      const rendered = renderStopList(route);

      // Every stop is rendered (no drops, no duplicates).
      assert.equal(rendered.length, route.stops.length);

      // Ordered by non-decreasing sequence.
      for (let i = 1; i < rendered.length; i++) {
        assert.ok(
          rendered[i].sequence >= rendered[i - 1].sequence,
          `sequence not non-decreasing at ${i}: ${rendered[i - 1].sequence} -> ${rendered[i].sequence}`
        );
      }

      // Each rendered stop carries a customer name and an ETA.
      for (const entry of rendered) {
        assert.equal(typeof entry.customer, "string");
        assert.ok(entry.customer.length >= 1);
        assert.equal(typeof entry.eta, "string");
        assert.ok(entry.eta.length >= 1);
      }

      // The rendered set is a permutation of the input (same {seq,name,eta} multiset).
      const key = (s) => `${s.sequence}\u0000${s.customer}\u0000${s.eta}`;
      const inKeys = route.stops.map(key).sort();
      const outKeys = rendered.map(key).sort();
      assert.deepEqual(outKeys, inKeys);
    }),
    { numRuns: 200 }
  );
});

test("renderStopList: marks the current stop and orders an unsorted input (Req 8.1)", () => {
  const route = {
    currentSequence: 2,
    stops: [
      { sequence: 3, customer: "C", eta: "t3" },
      { sequence: 1, customer: "A", eta: "t1" },
      { sequence: 2, customer: "B", eta: "t2" },
    ],
  };
  const rendered = renderStopList(route);
  assert.deepEqual(
    rendered.map((s) => s.sequence),
    [1, 2, 3]
  );
  assert.deepEqual(
    rendered.map((s) => s.isCurrent),
    [false, true, false]
  );
});

test("renderStopList: carries a persisted completion's category/deviationMin through, null when not completed", () => {
  const route = {
    currentSequence: 2,
    stops: [
      { sequence: 1, customer: "A", eta: "t1", completed: true, category: "late", deviationMin: 20 },
      { sequence: 2, customer: "B", eta: "t2" },
    ],
  };
  const rendered = renderStopList(route);
  assert.equal(rendered[0].category, "late");
  assert.equal(rendered[0].deviationMin, 20);
  assert.equal(rendered[1].category, null);
  assert.equal(rendered[1].deviationMin, null);
});

// ---------------------------------------------------------------------------
// Property 19 (task 14.3) — Validates: Requirements 8.4
// ---------------------------------------------------------------------------

test("Property 19: the empty-plan message appears exactly when there are no stops", () => {
  // Feature: excel-route-planning, Property 19: The empty-plan message appears exactly when there are no stops
  const planArb = fc.record({
    stops: fc.array(fc.record({ sequence: fc.integer() }), { maxLength: 12 }),
  });

  fc.assert(
    fc.property(planArb, (plan) => {
      assert.equal(shouldShowEmptyMessage(plan), plan.stops.length === 0);
    }),
    { numRuns: 200 }
  );
});

test("shouldShowEmptyMessage: null/undefined/malformed plans count as empty (Req 8.4)", () => {
  assert.equal(shouldShowEmptyMessage(null), true);
  assert.equal(shouldShowEmptyMessage(undefined), true);
  assert.equal(shouldShowEmptyMessage({}), true);
  assert.equal(shouldShowEmptyMessage({ stops: [] }), true);
  assert.equal(shouldShowEmptyMessage({ stops: [{ sequence: 1 }] }), false);
});

// ---------------------------------------------------------------------------
// Property 20 (task 14.4) — Validates: Requirements 9.1, 9.2, 9.4
// ---------------------------------------------------------------------------

test("Property 20: Google Maps link targets coordinates, then address, else falls back to null", () => {
  // Feature: excel-route-planning, Property 20: Google Maps link targets coordinates, then address, else falls back

  // Coordinates present -> destination is "lat,lng" (and coords win over any address).
  fc.assert(
    fc.property(latArb, lngArb, fc.option(addressArb, { nil: undefined }), (lat, lng, address) => {
      const url = buildMapsUrl({ location: { lat, lng }, address });
      assert.notEqual(url, null);
      const dest = new URL(url).searchParams.get("destination");
      assert.equal(dest, `${lat},${lng}`);
    }),
    { numRuns: 150 }
  );

  // Address only (no usable coords) -> destination is the URL-encoded address.
  fc.assert(
    fc.property(addressArb, (address) => {
      const url = buildMapsUrl({ location: null, address });
      assert.notEqual(url, null);
      // URLSearchParams decodes the destination, verifying the address was encoded.
      const dest = new URL(url).searchParams.get("destination");
      assert.equal(dest, address);
    }),
    { numRuns: 150 }
  );

  // Neither coordinates nor a usable address -> null (view shows fallback text).
  const neitherArb = fc.record({
    location: fc.constantFrom(null, undefined, {}, { lat: 1 }, { lng: 1 }, { lat: "a", lng: "b" }),
    address: fc.constantFrom(null, undefined, "", "   ", "\t"),
  });
  fc.assert(
    fc.property(neitherArb, (stop) => {
      assert.equal(buildMapsUrl(stop), null);
    }),
    { numRuns: 100 }
  );
});

test("buildMapsUrl: exact coordinate and address URL shapes (Req 9.1, 9.2)", () => {
  assert.equal(
    buildMapsUrl({ location: { lat: 13.72, lng: 100.53 } }),
    "https://www.google.com/maps/dir/?api=1&destination=13.72,100.53"
  );
  assert.equal(
    buildMapsUrl({ address: "123 ถนน สุขุมวิท" }),
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("123 ถนน สุขุมวิท")}`
  );
  assert.equal(buildMapsUrl({}), null);
});

// ---------------------------------------------------------------------------
// Example tests (task 14.5) — Validates: Requirements 8.2, 8.5, 9.3
// ---------------------------------------------------------------------------

test("renderRoute: shows exactly the empty message for a zero-stop plan (Req 8.4)", () => {
  const calls = [];
  const ops = {
    showEmpty: () => calls.push("empty"),
    showStops: () => calls.push("stops"),
    showFallback: () => calls.push("fallback"),
  };
  assert.equal(renderRoute({ stops: [] }, ops), "empty");
  assert.deepEqual(calls, ["empty"]);
});

test("renderRoute: renders the stop list for a non-empty plan (Req 8.1)", () => {
  let shown = null;
  const ops = {
    showEmpty: () => assert.fail("empty message should not show for a non-empty plan"),
    showStops: (vm) => {
      shown = vm;
    },
    showFallback: () => assert.fail("fallback should not fire on the happy path"),
  };
  const result = renderRoute(
    { stops: [{ sequence: 1, customer: "A", eta: "t1" }], currentSequence: 1 },
    ops
  );
  assert.equal(result, "stops");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].customer, "A");
});

test("renderRoute: falls back to 'plan could not be loaded' when the empty message cannot be displayed (Req 8.5)", () => {
  const calls = [];
  const ops = {
    showEmpty: () => {
      calls.push("empty");
      throw new Error("DOM write failed"); // simulate the empty message failing to render
    },
    showStops: () => calls.push("stops"),
    showFallback: () => calls.push("fallback"),
  };
  const result = renderRoute({ stops: [] }, ops);
  assert.equal(result, "error");
  // The empty branch was attempted, then the fallback was shown.
  assert.deepEqual(calls, ["empty", "fallback"]);
});

test("renderRoute: falls back when rendering a non-empty stop list throws (Req 8.5)", () => {
  const calls = [];
  const ops = {
    showEmpty: () => calls.push("empty"),
    showStops: () => {
      calls.push("stops");
      throw new Error("stop render failed");
    },
    showFallback: () => calls.push("fallback"),
  };
  const result = renderRoute({ stops: [{ sequence: 1, customer: "A", eta: "t" }] }, ops);
  assert.equal(result, "error");
  assert.deepEqual(calls, ["stops", "fallback"]);
});

test("driver.js builds maps links that open in a new context with rel=noopener (Req 9.3)", () => {
  const driverJs = readFileSync(
    fileURLToPath(new URL("../public/driver.js", import.meta.url)),
    "utf8"
  );
  assert.ok(
    driverJs.includes('target="_blank"'),
    'expected driver.js to open maps links with target="_blank"'
  );
  assert.ok(
    driverJs.includes('rel="noopener"'),
    'expected driver.js to set rel="noopener" on maps links'
  );
});

test("driver.html is mobile-first: viewport meta and a max-width container (Req 8.2)", () => {
  const driverHtml = readFileSync(
    fileURLToPath(new URL("../public/driver.html", import.meta.url)),
    "utf8"
  );
  const driverCss = readFileSync(
    fileURLToPath(new URL("../public/driver.css", import.meta.url)),
    "utf8"
  );

  assert.ok(driverHtml.includes('name="viewport"'), "expected a viewport meta tag");
  assert.ok(
    driverHtml.includes("width=device-width"),
    "expected the viewport to use width=device-width"
  );
  assert.ok(driverCss.includes("max-width"), "expected a max-width container in driver.css");
});

// Guard the exported message constants so the UI copy stays intentional.
test("driver-view message constants describe the empty and fallback states", () => {
  assert.match(EMPTY_MESSAGE, /no stops to deliver/i);
  assert.match(FALLBACK_MESSAGE, /could not be loaded/i);
});
