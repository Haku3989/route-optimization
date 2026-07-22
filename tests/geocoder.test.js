import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  createGeocoder,
  resolveShopCoordinates,
  EstimatorGeocoder,
  LongdoGeocoder,
} from "../src/routing/geocoder.js";

// --- Generators -------------------------------------------------------------

// A guaranteed-usable coordinate pair: finite numbers that are not (0,0).
const usableCoordArb = fc
  .record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lng: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((c) => !(c.lat === 0 && c.lng === 0));

// Values that `toFiniteNumber` must reject (blank or non-numeric). Note Number("")
// and Number("  ") are 0, so the geocoder deliberately treats them as null.
const nonNumericArb = fc.constantFrom("abc", "N/A", "-", "", "  ", "lat", "x1y");

const shopNameArb = fc.constantFrom("ร้าน A", "Shop B", "ร้านค้าทดสอบ", "Big C สาขา 1");
const codeArb = fc
  .array(fc.constantFrom(..."ABCabc0123456789".split("")), { minLength: 1, maxLength: 8 })
  .map((c) => c.join(""));

// One resolution scenario: how the master coords look, and what the (fake)
// geocoder returns for the second-step lookup.
const caseArb = fc.record({
  masterScenario: fc.constantFrom("usable", "missing", "nonNumeric", "zero"),
  usableMaster: usableCoordArb,
  nonNumeric: fc.record({ lat: nonNumericArb, long: nonNumericArb }),
  geoScenario: fc.constantFrom("usable", "null", "zero"),
  usableGeo: usableCoordArb,
  shopName: shopNameArb,
  code: codeArb,
});

/** Build a shop record whose raw `coordinates` reflect the master scenario. */
function buildShop(c) {
  let coordinates;
  switch (c.masterScenario) {
    case "usable":
      coordinates = { lat: c.usableMaster.lat, long: c.usableMaster.lng };
      break;
    case "nonNumeric":
      coordinates = { lat: c.nonNumeric.lat, long: c.nonNumeric.long };
      break;
    case "zero":
      coordinates = { lat: 0, long: 0 };
      break;
    case "missing":
    default:
      coordinates = { lat: null, long: null };
      break;
  }
  return { customerCode: c.code, shopName: c.shopName, coordinates };
}

/** A fake geocoder that records calls and returns a preconfigured result. */
function makeFakeGeocoder(result) {
  return {
    calls: 0,
    lastQuery: undefined,
    async geocode(query) {
      this.calls += 1;
      this.lastQuery = query;
      return result;
    },
  };
}

// --- Property 4 -------------------------------------------------------------
// Feature: excel-route-planning, Property 4: Coordinate resolution follows precedence and excludes unusable coordinates
// Validates: Requirements 2.1, 2.2, 2.3, 2.4
test("Property 4: coordinate resolution follows master-first precedence and excludes unusable coords", async () => {
  await fc.assert(
    fc.asyncProperty(caseArb, async (c) => {
      const shop = buildShop(c);

      const geoResult =
        c.geoScenario === "usable"
          ? { lat: c.usableGeo.lat, lng: c.usableGeo.lng }
          : c.geoScenario === "zero"
            ? { lat: 0, lng: 0 }
            : null;
      const geocoder = makeFakeGeocoder(geoResult);

      const out = await resolveShopCoordinates(shop, geocoder);

      const masterUsable = c.masterScenario === "usable";
      const geoUsable = c.geoScenario === "usable";

      if (masterUsable) {
        // Precedence: master coords win and the geocoder is never consulted.
        assert.equal(out.resolved, true);
        assert.equal(out.source, "master");
        assert.deepEqual(out.location, {
          lat: c.usableMaster.lat,
          lng: c.usableMaster.lng,
        });
        assert.equal(geocoder.calls, 0);
      } else if (geoUsable) {
        // Master unusable -> geocode, and a usable result is adopted as longdo.
        assert.equal(out.resolved, true);
        assert.equal(out.source, "longdo");
        assert.deepEqual(out.location, {
          lat: c.usableGeo.lat,
          lng: c.usableGeo.lng,
        });
        assert.equal(geocoder.calls, 1);
      } else {
        // Master unusable AND geocoder returned null or (0,0) -> unresolved.
        assert.equal(out.resolved, false);
        assert.equal(out.source, "unresolved");
        assert.equal(out.location, null);
        assert.equal(typeof out.reason, "string");
        assert.ok(out.reason.length > 0, "unresolved result carries a reason");
        assert.equal(geocoder.calls, 1);
      }
    }),
    { numRuns: 200 }
  );
});

// --- Example: estimator never resolves, so a shop without master coords is unresolved
test("EstimatorGeocoder returns null and leaves coordinate-less shops unresolved", async () => {
  const geocoder = createGeocoder(); // default estimator
  assert.ok(geocoder instanceof EstimatorGeocoder);
  assert.equal(await geocoder.geocode("anywhere"), null);

  const out = await resolveShopCoordinates(
    { customerCode: "X1", shopName: "ร้านไม่มีพิกัด", coordinates: { lat: null, long: null } },
    geocoder
  );
  assert.equal(out.resolved, false);
  assert.equal(out.source, "unresolved");
  assert.equal(out.location, null);
});

// --- Example: longdo selected without a key falls back to the estimator
test("createGeocoder falls back to the estimator when longdo has no key", () => {
  const saved = process.env.LONGDO_API_KEY;
  delete process.env.LONGDO_API_KEY;
  try {
    const geocoder = createGeocoder({ provider: "longdo" });
    assert.ok(geocoder instanceof EstimatorGeocoder);
  } finally {
    if (saved !== undefined) process.env.LONGDO_API_KEY = saved;
  }
});

// --- Task 7.3: Longdo geocoder request/response (example, external service) --
// Validates: Requirement 2.2
test("LongdoGeocoder builds a keyed search URL and parses lat/lng from the response", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    // A representative Longdo map-search body: a `data` array of results whose
    // longitude field is `lon`.
    return {
      ok: true,
      json: async () => ({
        data: [
          { name: "ร้านสมชาย", lat: 13.7466, lon: 100.5347 },
          { name: "อื่น ๆ", lat: 14.0, lon: 101.0 },
        ],
      }),
    };
  };

  try {
    const geocoder = createGeocoder({ provider: "longdo", apiKey: "TEST_KEY" });
    assert.ok(geocoder instanceof LongdoGeocoder);

    const result = await geocoder.geocode("ร้านสมชาย กรุงเทพ");

    // Parsed from the FIRST result.
    assert.deepEqual(result, { lat: 13.7466, lng: 100.5347 });

    // Request shape: exactly one call, carrying the key and the encoded keyword.
    assert.equal(calls.length, 1);
    const url = calls[0];
    assert.ok(url.includes("key=TEST_KEY"), "URL includes the key query param");
    assert.ok(
      url.includes(`keyword=${encodeURIComponent("ร้านสมชาย กรุงเทพ")}`),
      "URL includes the URL-encoded keyword"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- A hanging request must not stall a bulk backfill run indefinitely -------
test("LongdoGeocoder: a hanging request is treated as unresolved after requestTimeoutMs, not forever", async () => {
  const originalFetch = globalThis.fetch;
  // Simulate an unresponsive endpoint: fetch never resolves on its own, only
  // rejects when the AbortController's signal fires.
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  try {
    const geocoder = createGeocoder({ provider: "longdo", apiKey: "K", requestTimeoutMs: 30 });
    const start = Date.now();
    const result = await geocoder.geocode("some address");
    const elapsedMs = Date.now() - start;

    assert.equal(result, null);
    assert.ok(elapsedMs < 2000, `should resolve near requestTimeoutMs, took ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Task 7.3: HTTP error and network failure both resolve to null -----------
// Validates: Requirement 2.2 (errors treated as unresolved)
test("LongdoGeocoder returns null on HTTP error and on a network throw", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Non-2xx HTTP response -> unresolved.
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const geocoder = createGeocoder({ provider: "longdo", apiKey: "K" });
    assert.equal(await geocoder.geocode("some address"), null);

    // Network layer throws -> unresolved, no exception escapes.
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await geocoder.geocode("some address"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
