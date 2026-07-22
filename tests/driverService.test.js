import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  login,
  resolveToken,
  getDriverRoute,
  advanceStop,
  completeStop,
  getDriverDaySummary,
  localDayKey,
} from "../src/services/driverService.js";
import {
  hashPassword,
  AuthError,
  GENERIC_AUTH_MESSAGE,
} from "../src/auth/credentials.js";

// ---------------------------------------------------------------------------
// Test helpers / fakes (no database, no network, real scrypt hashing)
// ---------------------------------------------------------------------------

/**
 * In-memory repository fake implementing only the driver-auth surface the
 * service uses: findDriverByUsername / insertSession / findSession /
 * deleteSession. Drivers are seeded with REAL scrypt hashes via hashPassword so
 * the credential round-trip is exercised end to end (never mocked).
 *
 * @param {Array<{ id:number, username:string, passwordHash:string, routeId?:string }>} [drivers]
 */
function makeFakeRepos(drivers = []) {
  const driversByUsername = new Map(drivers.map((d) => [d.username, d]));
  const sessions = new Map(); // token -> { driverId, expiresAt }
  const completions = []; // upserted delivery_completions rows, in insertion order
  return {
    async findDriverByUsername(username) {
      return driversByUsername.get(username) || null;
    },
    async insertSession(token, driverId, expiresAt = null) {
      sessions.set(token, { driverId, expiresAt: expiresAt ?? null });
    },
    async findSession(token) {
      return sessions.get(token) || null;
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
    async upsertDeliveryCompletion(record) {
      const i = completions.findIndex(
        (c) => c.driverId === record.driverId && c.customerCode === record.customerCode && c.day === record.day
      );
      if (i >= 0) completions[i] = record;
      else completions.push(record);
    },
    async deliveryCompletionsForDriverDay(driverId, day) {
      return completions
        .filter((c) => c.driverId === driverId && c.day === day)
        .map((c) => ({
          customerCode: c.customerCode,
          customerName: c.customerName ?? null,
          scheduledEta: c.scheduledEta ?? null,
          completedAt: c.completedAt,
          deviationMin: c.deviationMin ?? null,
          category: c.category ?? null,
        }));
    },
    // Exposed for assertions in tests.
    _sessions: sessions,
    _completions: completions,
  };
}

// Passwords span ASCII, unicode/Thai, binary, and the empty string so the
// credential layer is exercised across a realistic input space.
const passwordArb = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.constantFrom("", " ", "p@ssw0rd", "ร้านสมชาย123", "😀🔐", "a".repeat(200))
);

// ---------------------------------------------------------------------------
// Property 21 (token half) (task 12.2) — Validates: Requirements 10.1
// ---------------------------------------------------------------------------

test("Property 21 (token half): a valid login issues a token that resolves to the driver id", async () => {
  // Feature: excel-route-planning, Property 21: Password hashing round-trips and valid login issues a resolvable token
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        username: fc.string({ minLength: 1, maxLength: 24 }),
        password: passwordArb,
        id: fc.integer({ min: 1, max: 1_000_000 }),
        routeId: fc.string({ minLength: 1, maxLength: 8 }),
      }),
      async ({ username, password, id, routeId }) => {
        const passwordHash = hashPassword(password);
        const repos = makeFakeRepos([{ id, username, passwordHash, routeId }]);
        const deps = { repositories: repos };

        const { token, driverId } = await login(username, password, deps);

        // A token is issued for the correct driver.
        assert.equal(driverId, id);
        assert.equal(typeof token, "string");
        assert.ok(token.length > 0);

        // The issued token was persisted as a session.
        assert.equal(repos._sessions.size, 1);
        assert.ok(repos._sessions.has(token));

        // resolveToken maps the freshly issued token back to that driver id.
        const resolved = await resolveToken(token, deps);
        assert.equal(resolved, id);
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 23 (unauthenticated) (task 12.3) — Validates: Requirements 10.3
// ---------------------------------------------------------------------------

test("Property 23: unauthenticated requests receive no route data", async () => {
  // Feature: excel-route-planning, Property 23: Unauthenticated requests receive no route data
  const tokenArb = fc.oneof(
    fc.string(),
    fc.constant(""),
    fc.constant(null),
    fc.constant(undefined),
    fc.integer(),
    fc.constant({}),
  );

  await fc.assert(
    fc.asyncProperty(tokenArb, async (token) => {
      // Empty session store => NO string is a currently valid issued token.
      const repos = makeFakeRepos([]);
      let routeProviderCalled = false;
      const deps = {
        repositories: repos,
        getRouteForDriver: async () => {
          routeProviderCalled = true;
          return { stops: [{ sequence: 1, customer: "leak" }] };
        },
      };

      // Access is denied with an AuthError...
      await assert.rejects(
        () => getDriverRoute(token, deps),
        (err) => err instanceof AuthError
      );
      // ...and NO route/stop data was ever produced (provider untouched).
      assert.equal(routeProviderCalled, false);

      // resolveToken agrees the token is not authenticated.
      assert.equal(await resolveToken(token, deps), null);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Property 18 (stop advancement) (task 12.4) — Validates: Requirements 8.3
// ---------------------------------------------------------------------------

/**
 * Independent oracle: the first uncompleted stop after `completedSeq` in
 * ascending sequence order, or null (terminal) when none remain. Marking
 * `completedSeq` completed does not affect stops after it, so the oracle reads
 * the original completed flags for sequences greater than `completedSeq`.
 */
function expectedCurrent(stops, completedSeq) {
  const after = stops
    .filter((s) => s.sequence > completedSeq && !s.completed)
    .sort((a, b) => a.sequence - b.sequence);
  return after.length > 0 ? after[0].sequence : null;
}

// Build a route of N stops (sequence 1..N, random completed flags) plus a
// completedSeq drawn from within that range.
const arbRouteAndSeq = fc.integer({ min: 1, max: 8 }).chain((n) =>
  fc
    .record({
      flags: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      completedSeq: fc.integer({ min: 1, max: n }),
      currentSequence: fc.integer({ min: 1, max: n }),
    })
    .map(({ flags, completedSeq, currentSequence }) => {
      const stops = flags.map((completed, i) => ({
        sequence: i + 1,
        completed,
        customer: `C${i + 1}`,
      }));
      return {
        route: { routeId: "R1", driverId: 1, stops, currentSequence },
        completedSeq,
      };
    })
);

test("Property 18: completing the current stop advances to the next uncompleted stop", () => {
  // Feature: excel-route-planning, Property 18: Completing the current stop advances to the next uncompleted stop
  fc.assert(
    fc.property(arbRouteAndSeq, ({ route, completedSeq }) => {
      const snapshot = structuredClone(route);

      const result = advanceStop(route, completedSeq);

      // Input is never mutated.
      assert.deepEqual(route, snapshot);

      // The completed stop is marked completed.
      const completedStop = result.stops.find((s) => s.sequence === completedSeq);
      assert.ok(completedStop);
      assert.equal(completedStop.completed, true);

      // Current advances to the first uncompleted stop after completedSeq, or
      // terminal (null) when none remain.
      assert.equal(result.currentSequence, expectedCurrent(route.stops, completedSeq));
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Example tests
// ---------------------------------------------------------------------------

test("login: unknown username and wrong password both throw AuthError with the same generic message (Req 10.2)", async () => {
  const password = "s3cret";
  const passwordHash = hashPassword(password);
  const repos = makeFakeRepos([
    { id: 7, username: "driver1", passwordHash, routeId: "R7" },
  ]);
  const deps = { repositories: repos };

  let unknownErr;
  await assert.rejects(
    () => login("nobody", password, deps),
    (e) => {
      unknownErr = e;
      return e instanceof AuthError;
    }
  );

  let badPwErr;
  await assert.rejects(
    () => login("driver1", "wrong-password", deps),
    (e) => {
      badPwErr = e;
      return e instanceof AuthError;
    }
  );

  // Identical, generic message — neither field is revealed.
  assert.equal(unknownErr.message, GENERIC_AUTH_MESSAGE);
  assert.equal(badPwErr.message, GENERIC_AUTH_MESSAGE);
  assert.equal(unknownErr.message, badPwErr.message);

  // A failed login never creates a session.
  assert.equal(repos._sessions.size, 0);
});

test("getDriverRoute: a valid token returns the assigned route; an unknown token is denied (Req 10.1, 10.3)", async () => {
  const password = "hunter2";
  const passwordHash = hashPassword(password);
  const repos = makeFakeRepos([
    { id: 42, username: "somchai", passwordHash, routeId: "R42" },
  ]);
  const fakeRoute = {
    routeId: "R42",
    driverId: 42,
    stops: [
      { sequence: 1, customer: "Shop A", completed: false },
      { sequence: 2, customer: "Shop B", completed: false },
    ],
    currentSequence: 1,
  };
  const deps = {
    repositories: repos,
    getRouteForDriver: async (driverId) => {
      assert.equal(driverId, 42);
      return fakeRoute;
    },
  };

  const { token } = await login("somchai", password, deps);

  // Happy path: the resolved driver's assigned route is returned.
  const { route } = await getDriverRoute(token, deps);
  assert.deepEqual(route, fakeRoute);

  // An unknown token is denied with no route data.
  await assert.rejects(
    () => getDriverRoute("not-a-real-token", deps),
    (err) => err instanceof AuthError
  );
});

test("resolveToken: an expired session resolves to null (Req 10.3)", async () => {
  const repos = makeFakeRepos([]);
  const deps = { repositories: repos };
  // Seed an already-expired session directly.
  await repos.insertSession("expired-token", 5, new Date(Date.now() - 1000));
  await repos.insertSession("live-token", 5, new Date(Date.now() + 60_000));

  assert.equal(await resolveToken("expired-token", deps), null);
  assert.equal(await resolveToken("live-token", deps), 5);
});

test("advanceStop: reaching the last stop sets a terminal (null) current sequence (Req 8.3)", () => {
  const route = {
    routeId: "R1",
    stops: [
      { sequence: 1, completed: true },
      { sequence: 2, completed: false },
    ],
    currentSequence: 2,
  };

  const result = advanceStop(route, 2);
  assert.equal(result.currentSequence, null);
  assert.equal(result.stops.find((s) => s.sequence === 2).completed, true);
  // Original route untouched.
  assert.equal(route.stops.find((s) => s.sequence === 2).completed, false);
});

test("advanceStop: skips already-completed stops when choosing the next current (Req 8.3)", () => {
  const route = {
    stops: [
      { sequence: 1, completed: false },
      { sequence: 2, completed: true }, // already done -> skip
      { sequence: 3, completed: false }, // first uncompleted after 1
    ],
    currentSequence: 1,
  };

  const result = advanceStop(route, 1);
  assert.equal(result.currentSequence, 3);
});

// ---------------------------------------------------------------------------
// completeStop / getDriverDaySummary
// ---------------------------------------------------------------------------

test("completeStop: persists a completion classified against the stop's own ETA", async () => {
  const repos = makeFakeRepos([]);
  const now = new Date("2026-07-19T04:20:00.000Z"); // 20 min after the ETA below -> late
  const route = {
    routeId: "Store A",
    stops: [{ sequence: 1, customerCode: "C1", customer: "Shop 1", eta: "2026-07-19T04:00:00.000Z", completed: false }],
  };
  const deps = { repositories: repos, getRouteForDriver: async () => route, now: () => now };

  await repos.insertSession("tok", 1);
  const result = await completeStop("tok", "C1", deps);

  assert.equal(result.category, "late");
  assert.equal(result.deviationMin, 20);
  assert.equal(result.scheduledEta, "2026-07-19T04:00:00.000Z");
  assert.equal(result.completedAt, now.toISOString());

  assert.equal(repos._completions.length, 1);
  assert.equal(repos._completions[0].driverId, 1);
  assert.equal(repos._completions[0].routeId, "Store A");
  assert.equal(repos._completions[0].customerCode, "C1");
  assert.equal(repos._completions[0].category, "late");
});

test("completeStop: a stop with no ETA is still recorded, with null deviation/category", async () => {
  const repos = makeFakeRepos([]);
  const route = { routeId: "Store A", stops: [{ sequence: 1, customerCode: "C1", customer: "Shop 1", eta: null }] };
  const deps = { repositories: repos, getRouteForDriver: async () => route };

  await repos.insertSession("tok", 1);
  const result = await completeStop("tok", "C1", deps);

  assert.equal(result.scheduledEta, null);
  assert.equal(result.deviationMin, null);
  assert.equal(result.category, null);
  assert.equal(repos._completions[0].deviationMin, null);
});

test("completeStop: a customerCode not in the current route is reported, not thrown/crashed", async () => {
  const repos = makeFakeRepos([]);
  const route = { routeId: "Store A", stops: [{ sequence: 1, customerCode: "C1", customer: "Shop 1", eta: null }] };
  const deps = { repositories: repos, getRouteForDriver: async () => route };

  await repos.insertSession("tok", 1);
  const result = await completeStop("tok", "DOES_NOT_EXIST", deps);

  assert.deepEqual(result, { message: "stop not found in current route" });
  assert.equal(repos._completions.length, 0);
});

test("completeStop: re-completing the same customer on the same day upserts, not duplicates", async () => {
  const repos = makeFakeRepos([]);
  const route = { routeId: "Store A", stops: [{ sequence: 1, customerCode: "C1", customer: "Shop 1", eta: "2026-07-19T04:00:00.000Z" }] };
  const deps = {
    repositories: repos,
    getRouteForDriver: async () => route,
    now: () => new Date("2026-07-19T04:05:00.000Z"),
  };

  await repos.insertSession("tok", 1);
  await completeStop("tok", "C1", deps);
  const second = await completeStop("tok", "C1", { ...deps, now: () => new Date("2026-07-19T04:10:00.000Z") });

  assert.equal(repos._completions.length, 1, "same driver/customer/day upserts in place");
  assert.equal(second.deviationMin, 10);
});

test("completeStop: an unauthenticated token is denied and the route provider is never consulted", async () => {
  const repos = makeFakeRepos([]);
  let called = false;
  const deps = { repositories: repos, getRouteForDriver: async () => { called = true; return { stops: [] }; } };

  await assert.rejects(() => completeStop("not-a-real-token", "C1", deps), (err) => err instanceof AuthError);
  assert.equal(called, false);
});

test("getDriverDaySummary: aggregates a driver's completions for one day", async () => {
  const repos = makeFakeRepos([]);
  const deps = { repositories: repos, now: () => new Date("2026-07-19T10:00:00.000Z") };
  await repos.insertSession("tok", 1);

  const day = "2026-07-19";
  await repos.upsertDeliveryCompletion({ driverId: 1, routeId: "R1", customerCode: "C1", completedAt: new Date(), deviationMin: -20, category: "early", day });
  await repos.upsertDeliveryCompletion({ driverId: 1, routeId: "R1", customerCode: "C2", completedAt: new Date(), deviationMin: 2, category: "on_time", day });
  await repos.upsertDeliveryCompletion({ driverId: 1, routeId: "R1", customerCode: "C3", completedAt: new Date(), deviationMin: 30, category: "late", day });
  // A different day must not be counted.
  await repos.upsertDeliveryCompletion({ driverId: 1, routeId: "R1", customerCode: "C4", completedAt: new Date(), deviationMin: 5, category: "on_time", day: "2026-07-18" });

  const summary = await getDriverDaySummary("tok", deps);

  assert.equal(summary.day, day);
  assert.equal(summary.completed, 3);
  assert.equal(summary.early, 1);
  assert.equal(summary.onTime, 1);
  assert.equal(summary.late, 1);
  assert.equal(summary.avgDeviationMin, 4); // (-20 + 2 + 30) / 3 = 4
});

test("getDriverDaySummary: no completions for the day -> zeroed summary, not an error", async () => {
  const repos = makeFakeRepos([]);
  await repos.insertSession("tok", 1);
  const deps = { repositories: repos, day: "2026-07-19" };

  const summary = await getDriverDaySummary("tok", deps);
  assert.equal(summary.completed, 0);
  assert.equal(summary.early, 0);
  assert.equal(summary.onTimePct, 0);
  assert.equal(summary.avgDeviationMin, null);
});

test("getDriverDaySummary: an unauthenticated token is denied", async () => {
  const repos = makeFakeRepos([]);
  await assert.rejects(
    () => getDriverDaySummary("not-a-real-token", { repositories: repos }),
    (err) => err instanceof AuthError
  );
});

test("localDayKey: formats a Date's LOCAL calendar day as YYYY-MM-DD", () => {
  assert.equal(localDayKey(new Date(2026, 6, 19, 23, 59)), "2026-07-19");
  assert.equal(localDayKey(new Date(2026, 0, 5, 0, 0)), "2026-01-05");
});
