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

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
