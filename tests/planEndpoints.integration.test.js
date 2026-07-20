/**
 * History / presale endpoint integration tests (task 16.2).
 *
 * Seeds DB rows via the repository layer, then issues representative requests to
 * `POST /api/history/compare` and `POST /api/presale/plan` against the running
 * Express app, asserting the response shapes and the guard messages.
 *
 * SKIPPED cleanly when `DATABASE_URL` is unset; `truncateAll()` runs between
 * tests for isolation. The guard-message constants are imported dynamically (in
 * `before`) so a skipped run never pulls in the pool via the service modules.
 *
 * _Requirements: 3.4, 5.1, 6.1_
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
} from "./helpers/dbIntegration.js";

let pool;
let repositories;
let app;
let server;
let baseUrl;
let HISTORY_MESSAGES;
let PRESALE_MESSAGES;

before(async () => {
  if (DB_SKIP) return;
  pool = await loadPool();
  repositories = await loadRepositories();
  app = await loadApp();
  // Dynamic imports so the pool is not constructed on a skipped run.
  ({ HISTORY_MESSAGES } = await import("../src/services/historyService.js"));
  ({ PRESALE_MESSAGES } = await import("../src/services/presaleService.js"));
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

/** Seed two resolvable shops + two history entries with distinct TIME_VISIT. */
async function seedHistory() {
  await repositories.upsertShops([
    {
      customerCode: "S1",
      shopName: "Shop One",
      location: { lat: 13.72, lng: 100.53 },
      coordSource: "master",
      serviceTimeMin: 10,
      openTime: "08:00",
      closeTime: "20:00",
    },
    {
      customerCode: "S2",
      shopName: "Shop Two",
      location: { lat: 13.74, lng: 100.55 },
      coordSource: "master",
      serviceTimeMin: 12,
      openTime: "08:00",
      closeTime: "20:00",
    },
  ]);
  await repositories.insertHistoryEntries([
    { customerCode: "S1", customerName: "Shop One", dcName: "DC1", timeVisit: "2026-01-10T09:00:00", quantity: 5 },
    { customerCode: "S2", customerName: "Shop Two", dcName: "DC1", timeVisit: "2026-01-10T11:00:00", quantity: 8 },
  ]);
}

/** Seed two resolvable presale customers + one with no matching shop. */
async function seedPresale() {
  await repositories.upsertShops([
    {
      customerCode: "P1",
      shopName: "Presale One",
      location: { lat: 13.72, lng: 100.53 },
      coordSource: "master",
      serviceTimeMin: 10,
      openTime: "08:00",
      closeTime: "20:00",
    },
    {
      customerCode: "P2",
      shopName: "Presale Two",
      location: { lat: 13.74, lng: 100.55 },
      coordSource: "master",
      serviceTimeMin: 12,
      openTime: "08:00",
      closeTime: "20:00",
    },
  ]);
  await repositories.insertPresaleEntries([
    { customerCode: "P1", customerName: "Presale One", deliveryDate: "2026-02-01", demand: 5 },
    { customerCode: "P2", customerName: "Presale Two", deliveryDate: "2026-02-01", demand: 8 },
    // No matching Shop_Master row -> must be unassigned, never routed (Req 5.5).
    { customerCode: "P9", customerName: "Presale Nine", deliveryDate: "2026-02-01", demand: 3 },
  ]);
}

test(
  "POST /api/history/compare returns a per-customer comparison for seeded rows (Req 3.4)",
  { skip: DB_SKIP },
  async () => {
    await seedHistory();

    const { res, json } = await postJson("/api/history/compare", { filters: {} });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.customers));
    assert.equal(json.customers.length, 2);
    for (const c of json.customers) {
      assert.ok(c.customerCode);
      assert.equal(typeof c.historicalSeq, "number");
      assert.equal(typeof c.optimizedSeq, "number");
      assert.ok("historicalEta" in c);
      assert.ok("optimizedEta" in c);
    }
    assert.equal(typeof json.historicalDistanceKm, "number");
    assert.equal(typeof json.optimizedDistanceKm, "number");
  }
);

test(
  "POST /api/history/compare returns the no-match guard message when the filter excludes everything",
  { skip: DB_SKIP },
  async () => {
    await seedHistory();

    const { res, json } = await postJson("/api/history/compare", {
      filters: { DC_Name: "DOES-NOT-EXIST" },
    });

    assert.equal(res.status, 200);
    assert.equal(json.message, HISTORY_MESSAGES.NO_RECORDS_MATCHED);
    assert.ok(!("customers" in json));
  }
);

test(
  "POST /api/presale/plan builds a plan and lists customers without coordinates as unassigned (Req 5.1)",
  { skip: DB_SKIP },
  async () => {
    await seedPresale();

    const { res, json } = await postJson("/api/presale/plan", {
      filters: {},
      depot: { lat: 13.7563, lng: 100.5018 },
      vehicles: [{ id: "V1", capacity: 1000, fuelType: "diesel", speedKmh: 40 }],
    });

    assert.equal(res.status, 200);
    assert.ok(json.plan);
    assert.ok(Array.isArray(json.plan.routes));
    assert.ok(Array.isArray(json.windowViolations));

    const routedIds = json.plan.routes.flatMap((r) => r.stops.map((s) => s.orderId));
    assert.ok(routedIds.includes("P1"));
    assert.ok(routedIds.includes("P2"));
    assert.ok(!routedIds.includes("P9"), "P9 has no shop and must not be routed");

    const unassignedCodes = json.unassigned.map((u) => u.customerCode);
    assert.ok(unassignedCodes.includes("P9"));
    const p9 = json.unassigned.find((u) => u.customerCode === "P9");
    assert.ok(p9.reason && p9.reason.length > 0);
  }
);

test(
  "POST /api/presale/plan returns the no-match guard message when the filter excludes everything (Req 6.1)",
  { skip: DB_SKIP },
  async () => {
    await seedPresale();

    const { res, json } = await postJson("/api/presale/plan", {
      filters: { DELIVERY_DATE: "1999-01-01" },
    });

    assert.equal(res.status, 200);
    assert.equal(json.message, PRESALE_MESSAGES.NO_CUSTOMERS_MATCHED);
    assert.ok(!("plan" in json));
  }
);
