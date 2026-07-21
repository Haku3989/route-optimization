/**
 * Daily delivery on-time report — real-Postgres integration test.
 *
 * Seeds `history_entries`/`shops` rows (one geocoded, one not) and exercises
 * `POST /api/delivery-report/compute` against the running Express app, so the
 * real `joinHistory()` SQL shape, `applyHistoryFilters`, `solveCVRP`, and the
 * estimator router are all exercised together — not just the unit-tested
 * service logic against fakes.
 *
 * SKIPPED cleanly when `TEST_DATABASE_URL` is unset; `truncateAll()` runs
 * between tests for isolation. NEVER run against `DATABASE_URL` — a prior
 * incident this session truncated the real dev DB by doing exactly that.
 */

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  DB_SKIP,
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
let authHeaders;

before(async () => {
  if (DB_SKIP) return;
  pool = await loadPool();
  repositories = await loadRepositories();
  app = await loadApp();
  await pool.initSchema();
  ({ server, baseUrl } = await startServer(app));
});

beforeEach(async () => {
  if (DB_SKIP) return;
  await repositories.truncateAll();
  authHeaders = await authAsAdmin(baseUrl);
});

after(async () => {
  if (DB_SKIP) return;
  await stopServer(server);
  await pool.close();
});

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { res, json };
}

async function seedDay() {
  await repositories.upsertShops([
    {
      customerCode: "R1",
      shopName: "Report Shop One",
      location: { lat: 13.72, lng: 100.53 },
      coordSource: "master",
      serviceTimeMin: 10,
      openTime: "08:00",
      closeTime: "20:00",
    },
  ]);
  await repositories.insertHistoryEntries([
    {
      customerCode: "R1",
      customerName: "Report Shop One",
      storeName: "Store R",
      dcName: "DC R",
      invoiceDate: "2026-07-19",
      timeVisit: "04:10",
    },
    // R2 has NO shop row at all -> must surface as excluded, not dropped.
    {
      customerCode: "R2",
      customerName: "Report Shop Two",
      storeName: "Store R",
      dcName: "DC R",
      invoiceDate: "2026-07-19",
      timeVisit: "04:20",
    },
  ]);
}

test(
  "POST /api/delivery-report/compute classifies a real routable delivery and excludes an unresolvable one",
  { skip: DB_SKIP },
  async () => {
    await seedDay();

    const { res, json } = await postJson("/api/delivery-report/compute", {
      filters: { deliveryDateFrom: "2026-07-19", deliveryDateTo: "2026-07-19" },
    });

    assert.equal(res.status, 200);
    assert.equal(json.day, "2026-07-19");
    assert.equal(json.toleranceMin, 15);

    assert.equal(json.rows.length, 1);
    assert.equal(json.rows[0].customerCode, "R1");
    assert.ok(["early", "on_time", "late"].includes(json.rows[0].category));

    const excludedR2 = json.excluded.find((e) => e.customerCode === "R2");
    assert.ok(excludedR2, "R2 (no shop row) must be surfaced as excluded, not silently dropped");
    assert.equal(excludedR2.reason, "no resolvable shop coordinates");

    assert.equal(json.stores.length, 1);
    assert.equal(json.stores[0].storeName, "Store R");
    assert.equal(json.stores[0].routableDeliveries, 1);
    assert.equal(json.stores[0].unroutableCount, 1);
  }
);

test(
  "POST /api/delivery-report/compute requires a single day",
  { skip: DB_SKIP },
  async () => {
    await seedDay();
    const { res, json } = await postJson("/api/delivery-report/compute", { filters: {} });
    assert.equal(res.status, 200);
    assert.match(json.message, /single day/);
  }
);

test(
  "POST /api/delivery-report/compute rejects an unauthenticated request with 401",
  { skip: DB_SKIP },
  async () => {
    const res = await fetch(`${baseUrl}/api/delivery-report/compute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filters: { deliveryDateFrom: "2026-07-19", deliveryDateTo: "2026-07-19" } }),
    });
    assert.equal(res.status, 401);
  }
);
