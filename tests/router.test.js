import test from "node:test";
import assert from "node:assert/strict";

import { createRouter, EstimatorRouter, LongdoRouter } from "../src/routing/router.js";

const A = { lat: 13.7563, lng: 100.5018 };
const B = { lat: 13.72, lng: 100.53 };
const C = { lat: 13.8, lng: 100.55 };

// --- createRouter selection --------------------------------------------------

test("createRouter defaults to the estimator with no provider configured", () => {
  const router = createRouter();
  assert.ok(router instanceof EstimatorRouter);
  assert.equal(router.provider, "estimator");
});

test("createRouter falls back to the estimator when longdo has no key", () => {
  const saved = process.env.LONGDO_API_KEY;
  delete process.env.LONGDO_API_KEY;
  try {
    const router = createRouter({ provider: "longdo" });
    assert.ok(router instanceof EstimatorRouter);
  } finally {
    if (saved !== undefined) process.env.LONGDO_API_KEY = saved;
  }
});

// --- LongdoRouter: graceful degradation on failure --------------------------
// A rate limit, outage, or malformed response must degrade to the built-in
// estimator per-leg rather than throwing and failing the whole plan/comparison.

test("LongdoRouter falls back to the estimator for a leg when Longdo errors (e.g. rate limit)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => "throw 'Too many requests, please contact sales at mm.co.th';",
  });

  try {
    const router = createRouter({ provider: "longdo", apiKey: "TEST_KEY" });
    assert.ok(router instanceof LongdoRouter);

    const legs = await router.routeLegs([A, B, C], { speedKmh: 35 });
    assert.equal(legs.length, 2);
    for (const leg of legs) {
      assert.equal(typeof leg.distanceKm, "number");
      assert.ok(leg.distanceKm > 0);
      assert.equal(typeof leg.durationMin, "number");
    }

    // The fallback distance matches the built-in estimator directly.
    const estimator = new EstimatorRouter();
    const expected = await estimator.routeLegs([A, B, C], { speedKmh: 35 });
    assert.equal(legs[0].distanceKm, expected[0].distanceKm);
    assert.equal(legs[1].distanceKm, expected[1].distanceKm);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LongdoRouter falls back on an HTTP error and on a network throw", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => "" });
    const router1 = createRouter({ provider: "longdo", apiKey: "K" });
    const legs1 = await router1.routeLegs([A, B], { speedKmh: 35 });
    assert.equal(legs1.length, 1);
    assert.ok(legs1[0].distanceKm > 0);

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const router2 = createRouter({ provider: "longdo", apiKey: "K" });
    const legs2 = await router2.routeLegs([A, B], { speedKmh: 35 });
    assert.equal(legs2.length, 1);
    assert.ok(legs2[0].distanceKm > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LongdoRouter caches a fallback result so a repeated leg does not re-fetch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "" };
  };

  try {
    const router = createRouter({ provider: "longdo", apiKey: "K" });
    // A -> B twice (e.g. shared between a baseline and an optimized ordering).
    await router.routeLegs([A, B], { speedKmh: 35 });
    await router.routeLegs([A, B], { speedKmh: 35 });
    assert.equal(calls, 1, "the second identical leg should be served from cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- LongdoRouter: circuit breaker + timeout ---------------------------------
// Regression: a route with many stops means many DISTINCT legs. Before this
// fix, every distinct leg re-attempted Longdo even after an earlier leg had
// already failed (e.g. a persistent rate limit) — an 11-stop presale route
// took 90+ seconds in production because each of the 12 distinct legs paid
// its own full failed-request cost. The circuit breaker means only the FIRST
// leg ever calls the network once Longdo has failed once.

test("LongdoRouter: after the first failure, DISTINCT later legs skip the network entirely", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "" };
  };

  try {
    const router = createRouter({ provider: "longdo", apiKey: "K" });
    // A route of 3 DISTINCT legs (A-B, B-C, C-D) — using genuinely different
    // pairs (not a repeat of A-B) proves the breaker, not the leg cache.
    const D = { lat: 13.9, lng: 100.6 };
    const legs = await router.routeLegs([A, B, C, D], { speedKmh: 35 });

    assert.equal(legs.length, 3);
    for (const leg of legs) assert.ok(leg.distanceKm > 0);
    assert.equal(calls, 1, "only the first (failing) leg should ever hit the network");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LongdoRouter: a hanging request is treated as a failure after requestTimeoutMs, not forever", async () => {
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
    const router = createRouter({ provider: "longdo", apiKey: "K", requestTimeoutMs: 30 });
    const start = Date.now();
    const legs = await router.routeLegs([A, B], { speedKmh: 35 });
    const elapsedMs = Date.now() - start;

    assert.equal(legs.length, 1);
    assert.ok(legs[0].distanceKm > 0, "falls back to the estimator instead of hanging");
    assert.ok(elapsedMs < 2000, `should resolve near requestTimeoutMs, took ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
