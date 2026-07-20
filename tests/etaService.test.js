import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { etasFromLegs, computeETAs, ETA_CONFIG } from "../src/services/etaService.js";

const { SERVICE_MINUTES_PER_STOP } = ETA_CONFIG;
const DAY_START = Date.UTC(2026, 0, 1, 0, 0, 0);

// -------------------------------------------------------------------------
// Backward-compatibility unit tests (options omitted must not change output)
// -------------------------------------------------------------------------

test("etasFromLegs (3-arg) keeps the original shape and default service time", () => {
  const stops = [{ id: "A" }, { id: "B" }];
  const legs = [
    { distanceKm: 2, durationMin: 6 },
    { distanceKm: 2, durationMin: 6 },
  ];
  const departAt = new Date("2026-01-01T08:00:00Z");
  const etas = etasFromLegs(stops, legs, departAt);

  // First stop: 6 min travel -> 08:06.
  assert.equal(etas[0].etaISO, "2026-01-01T08:06:00.000Z");
  // Second stop: 6 + 8 (default service) + 6 -> 08:20.
  assert.equal(etas[1].etaISO, "2026-01-01T08:20:00.000Z");
  // No window fields are added when flagWindows is off.
  assert.deepEqual(Object.keys(etas[0]).sort(), ["cumulativeKm", "cumulativeMin", "etaISO", "orderId"]);
});

// -------------------------------------------------------------------------
// Unit tests for the new options behaviour
// -------------------------------------------------------------------------

test("per-stop serviceTimeMin overrides the default when options omitted", () => {
  const stops = [
    { id: "A", serviceTimeMin: 15 },
    { id: "B" },
  ];
  const legs = [
    { distanceKm: 0, durationMin: 10 },
    { distanceKm: 0, durationMin: 10 },
  ];
  const departAt = new Date(DAY_START);
  const etas = etasFromLegs(stops, legs, departAt);

  // Stop A at 10 min.
  assert.equal(etas[0].cumulativeMin, 10);
  // Stop B at 10 + 15 (A's service) + 10 = 35 min.
  assert.equal(etas[1].cumulativeMin, 35);
});

test("serviceMinutesFor takes precedence over stop.serviceTimeMin", () => {
  const stops = [{ id: "A", serviceTimeMin: 15 }, { id: "B" }];
  const legs = [
    { distanceKm: 0, durationMin: 10 },
    { distanceKm: 0, durationMin: 10 },
  ];
  const departAt = new Date(DAY_START);
  const etas = etasFromLegs(stops, legs, departAt, {
    serviceMinutesFor: () => 5,
    flagWindows: true,
  });

  assert.equal(etas[0].serviceMin, 5);
  // Stop B at 10 + 5 + 10 = 25 min.
  assert.equal(etas[1].cumulativeMin, 25);
});

test("flagWindows marks a violation outside the window and clears inside it", () => {
  const stops = [
    { id: "early", openTime: "09:00", closeTime: "17:00" }, // ETA 08:30 -> violation
    { id: "ok", openTime: "00:00", closeTime: "23:59" }, // always inside
    { id: "nowindow" }, // no window -> never a violation
  ];
  const legs = [
    { distanceKm: 0, durationMin: 30 }, // 08:30
    { distanceKm: 0, durationMin: 30 },
    { distanceKm: 0, durationMin: 30 },
  ];
  const departAt = new Date("2026-01-01T08:00:00Z");
  const etas = etasFromLegs(stops, legs, departAt, { flagWindows: true });

  assert.equal(etas[0].windowViolation, true);
  assert.ok(typeof etas[0].windowReason === "string" && etas[0].windowReason.length > 0);
  assert.equal(etas[1].windowViolation, false);
  assert.equal(etas[2].windowViolation, false);
  assert.equal(etas[2].windowReason, undefined);
});

test("computeETAs is unchanged (default service, strictly increasing)", () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicle = { id: "V1", speedKmh: 40 };
  const stops = [
    { id: "A", location: { lat: 13.76, lng: 100.51 } },
    { id: "B", location: { lat: 13.8, lng: 100.55 } },
  ];
  const etas = computeETAs(depot, vehicle, stops, new Date(DAY_START));
  assert.equal(etas.length, 2);
  assert.ok(new Date(etas[1].etaISO) > new Date(etas[0].etaISO));
});

// -------------------------------------------------------------------------
// Property-based tests
// -------------------------------------------------------------------------

// Feature: excel-route-planning, Property 15: Per-stop service time is applied, defaulting when absent
// Validates: Requirements 5.4, 7.2, 7.3
test("Property 15: per-stop service time is applied, defaulting when absent", () => {
  // A stop either declares an integer serviceTimeMin or leaves it absent.
  const stopArb = fc.record(
    {
      id: fc.string({ minLength: 1, maxLength: 4 }),
      serviceTimeMin: fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined }),
    },
    { requiredKeys: ["id"] }
  );
  const legArb = fc.record({
    distanceKm: fc.integer({ min: 0, max: 50 }),
    durationMin: fc.integer({ min: 0, max: 120 }),
  });

  fc.assert(
    fc.property(
      fc.array(stopArb, { minLength: 1, maxLength: 12 }),
      fc.array(legArb, { minLength: 12, maxLength: 12 }),
      (stops, legs) => {
        const departAt = new Date(DAY_START);
        const etas = etasFromLegs(stops, legs, departAt, { flagWindows: true });

        const expectedService = (stop) =>
          Number.isFinite(stop.serviceTimeMin) ? stop.serviceTimeMin : SERVICE_MINUTES_PER_STOP;

        // The reported serviceMin equals the stop's value, defaulting when absent.
        for (let i = 0; i < stops.length; i++) {
          assert.equal(etas[i].serviceMin, expectedService(stops[i]));
        }

        // The cumulative-clock delta between consecutive stops equals the
        // previous stop's applied service time plus the intervening leg.
        for (let i = 1; i < stops.length; i++) {
          const delta = etas[i].cumulativeMin - etas[i - 1].cumulativeMin;
          assert.equal(delta, legs[i].durationMin + expectedService(stops[i - 1]));
        }
      }
    ),
    { numRuns: 200 }
  );
});

// Feature: excel-route-planning, Property 16: Time-window violation flag is exact
// Validates: Requirements 7.1
test("Property 16: time-window violation flag is exact", () => {
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  // A window is a valid inclusive [open, close] pair (open <= close).
  const windowArb = fc
    .tuple(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 0, max: 1439 }))
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]));

  const stopArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    window: windowArb,
  });
  const legArb = fc.record({
    distanceKm: fc.integer({ min: 0, max: 20 }),
    durationMin: fc.integer({ min: 0, max: 240 }),
  });

  fc.assert(
    fc.property(
      fc.array(stopArb, { minLength: 1, maxLength: 12 }),
      fc.array(legArb, { minLength: 12, maxLength: 12 }),
      fc.integer({ min: 0, max: 1439 }), // depart time-of-day (whole minute, UTC)
      (rawStops, legs, departMin) => {
        const stops = rawStops.map((s) => ({
          id: s.id,
          openTime: clock(s.window[0]),
          closeTime: clock(s.window[1]),
        }));
        const departAt = new Date(DAY_START + departMin * 60_000);
        const etas = etasFromLegs(stops, legs, departAt, { flagWindows: true });

        for (let i = 0; i < stops.length; i++) {
          const eta = new Date(etas[i].etaISO);
          const todMin = eta.getUTCHours() * 60 + eta.getUTCMinutes();
          const [openMin, closeMin] = rawStops[i].window;
          const expectedViolation = todMin < openMin || todMin > closeMin;
          assert.equal(
            etas[i].windowViolation,
            expectedViolation,
            `stop ${i}: eta tod=${todMin} window=[${openMin},${closeMin}]`
          );
        }
      }
    ),
    { numRuns: 200 }
  );
});
