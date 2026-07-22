/**
 * Driver-flow integration test (task 16.3).
 *
 * Seeds a driver via `src/db/seedDrivers.js` (`seedDrivers()`, which hashes the
 * password with scrypt — never plaintext), then drives the auth flow against the
 * running Express app:
 *   - POST /api/driver/login with correct creds -> 200 { token, driverId } and a
 *     persisted `driver_sessions` row.
 *   - the session is DURABLE: an independent pool (simulating a restart) still
 *     resolves the token.
 *   - GET /api/driver/route with the Bearer token -> 200 { route }.
 *   - GET without a token, and with an unknown token -> 401 with NO route data.
 *
 * SKIPPED cleanly when `TEST_DATABASE_URL` is unset; `truncateAll()` runs
 * between tests for isolation. `seedDrivers` and `pg` are imported dynamically
 * so a skipped run never constructs the pool.
 *
 * _Requirements: 10.1, 10.3_
 */

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  DB_SKIP,
  DATABASE_URL,
  loadPool,
  loadRepositories,
  loadApp,
  startServer,
  stopServer,
  authAsAdmin,
} from "./helpers/dbIntegration.js";

let pool;
let repositories;
let app;
let server;
let baseUrl;
let seedDrivers;
let pg;

before(async () => {
  if (DB_SKIP) return;
  pool = await loadPool();
  repositories = await loadRepositories();
  app = await loadApp();
  ({ seedDrivers } = await import("../src/db/seedDrivers.js"));
  ({ default: pg } = await import("pg"));
  await pool.initSchema();
  ({ server, baseUrl } = await startServer(app));
});

beforeEach(async () => {
  if (DB_SKIP) return;
  await repositories.truncateAll();
});

after(async () => {
  if (DB_SKIP) return;
  await stopServer(server);
  await pool.close();
});

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { res, json };
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers });
  const json = await res.json();
  return { res, json };
}

test(
  "driver login persists a session, issues a working token, and the session is durable (Req 10.1)",
  { skip: DB_SKIP },
  async () => {
    const username = "driver-int";
    const password = "s3cret-int-pw";
    const routeId = "route-int";
    // Seeded via seedDrivers -> scrypt hash stored, never plaintext.
    await seedDrivers([{ username, routeId, password }]);

    // Correct credentials -> 200 { token, driverId }.
    const login = await postJson("/api/driver/login", { username, password });
    assert.equal(login.res.status, 200);
    assert.equal(typeof login.json.token, "string");
    assert.ok(login.json.token.length > 0);
    assert.ok(login.json.driverId != null);
    const { token, driverId } = login.json;

    // A session row was persisted for the issued token.
    const sess = await pool.query(
      "SELECT driver_id FROM driver_sessions WHERE token = $1",
      [token]
    );
    assert.equal(sess.rows.length, 1);
    assert.equal(String(sess.rows[0].driver_id), String(driverId));

    // Durability: an INDEPENDENT pool (as a fresh process would build) still
    // resolves the persisted session token.
    const freshPool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      const durable = await freshPool.query(
        "SELECT driver_id FROM driver_sessions WHERE token = $1",
        [token]
      );
      assert.equal(durable.rows.length, 1);
      assert.equal(String(durable.rows[0].driver_id), String(driverId));
    } finally {
      await freshPool.end();
    }

    // GET /route with the Bearer token -> 200 { route }.
    const route = await getJson("/api/driver/route", {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(route.res.status, 200);
    assert.ok(route.json.route);
    assert.ok(Array.isArray(route.json.route.stops));
  }
);

test(
  "GET /api/driver/route denies missing and unknown tokens with 401 and no route data (Req 10.3)",
  { skip: DB_SKIP },
  async () => {
    // No Authorization header -> 401, and NO route/stop data in the body.
    const noToken = await getJson("/api/driver/route", {});
    assert.equal(noToken.res.status, 401);
    assert.equal(noToken.json.route, undefined);
    assert.ok(!("stops" in noToken.json));

    // Unknown/invalid token -> 401, and NO route/stop data in the body.
    const badToken = await getJson("/api/driver/route", {
      Authorization: "Bearer not-a-real-token",
    });
    assert.equal(badToken.res.status, 401);
    assert.equal(badToken.json.route, undefined);
    assert.ok(!("stops" in badToken.json));
  }
);

test(
  "POST /api/driver/complete persists a real completion, GET /route reflects it after refresh, GET /summary aggregates it (live driver tracking)",
  { skip: DB_SKIP },
  async () => {
    // Seed a routable customer and build a real presale plan for it via admin
    // auth, so the driver's route carries a real computed ETA to complete against.
    await repositories.upsertShops([
      {
        customerCode: "D1",
        shopName: "Driver Stop One",
        location: { lat: 13.72, lng: 100.53 },
        coordSource: "master",
        serviceTimeMin: 10,
        openTime: "08:00",
        closeTime: "20:00",
      },
    ]);
    await repositories.insertPresaleEntries([
      { customerCode: "D1", customerName: "Driver Stop One", deliveryDate: "2026-07-19", demand: 1 },
    ]);

    const adminAuthHeaders = await authAsAdmin(baseUrl);
    const planRes = await fetch(`${baseUrl}/api/presale/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuthHeaders },
      body: JSON.stringify({
        filters: {},
        depot: { lat: 13.7563, lng: 100.5018 },
        vehicles: [{ id: "route-driver-int", capacity: 1000, fuelType: "diesel", speedKmh: 40 }],
      }),
    });
    const plan = await planRes.json();
    assert.equal(planRes.status, 200);
    const routedIds = plan.plan.routes.flatMap((r) => r.stops.map((s) => s.orderId));
    assert.ok(routedIds.includes("D1"), "the seeded customer must actually be on the built route");

    // Seed a driver assigned to that same route/vehicle id, and log in.
    const username = "driver-complete-int";
    const password = "s3cret-complete-pw";
    await seedDrivers([{ username, routeId: "route-driver-int", password }]);
    const login = await postJson("/api/driver/login", { username, password });
    const { token } = login.json;
    const driverAuth = { Authorization: `Bearer ${token}` };

    // Sanity: the driver's own route includes D1, not yet completed.
    const before = await getJson("/api/driver/route", driverAuth);
    const stopBefore = before.json.route.stops.find((s) => s.customerCode === "D1");
    assert.ok(stopBefore, "driver's route must include the seeded stop");
    assert.equal(stopBefore.completed, false);

    // Mark it complete.
    const complete = await postJson(
      "/api/driver/complete",
      { customerCode: "D1" },
      driverAuth
    );
    assert.equal(complete.res.status, 200);
    assert.ok(["early", "on_time", "late"].includes(complete.json.category));
    assert.equal(typeof complete.json.deviationMin, "number");

    // The row is really persisted (not just in-memory optimistic state).
    const row = await pool.query(
      "SELECT customer_code, category, deviation_min FROM delivery_completions WHERE driver_id = $1",
      [login.json.driverId]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].customer_code, "D1");

    // GET /route again (simulating a page refresh) must still show it completed —
    // this is the whole point of persisting rather than relying on client state.
    const after = await getJson("/api/driver/route", driverAuth);
    const stopAfter = after.json.route.stops.find((s) => s.customerCode === "D1");
    assert.equal(stopAfter.completed, true);
    assert.equal(stopAfter.category, complete.json.category);

    // GET /summary aggregates today's completion.
    const summary = await getJson("/api/driver/summary", driverAuth);
    assert.equal(summary.res.status, 200);
    assert.equal(summary.json.completed, 1);
    assert.equal(summary.json[toCamelCategory(complete.json.category)], 1);
  }
);

/** "early" -> "early", "on_time" -> "onTime", "late" -> "late" (matches the
 * summary response's field names). */
function toCamelCategory(category) {
  return category === "on_time" ? "onTime" : category;
}
