/**
 * Integration tests for the raw-SQL repository layer (task 3.4).
 *
 * These exercise the REAL `pg` layer and SQL against a Postgres database and are
 * SKIPPED cleanly when `DATABASE_URL` is not set (see tests/helpers/dbIntegration.js).
 * When a DB is configured, the schema is applied once (before) and every table
 * is truncated between tests (beforeEach) for isolation; the pool is closed after.
 *
 * Coverage (Requirements 1.8, 2.5):
 *   - upsertShops → joinPresale / joinHistory round-trip the stored rows.
 *   - a repeat upsertShops on the same customer_code UPDATES rather than
 *     duplicates (verifies the ON CONFLICT upsert).
 *   - master columns win in the join: joined coords / service_time_min /
 *     open_time / close_time come from the Shop_Master row (Requirement 2.5).
 */

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { DB_SKIP, loadPool, loadRepositories } from "./helpers/dbIntegration.js";

let pool;
let repositories;

before(async () => {
  if (DB_SKIP) return;
  pool = await loadPool();
  repositories = await loadRepositories();
  await pool.initSchema(); // idempotent CREATE ... IF NOT EXISTS
});

beforeEach(async () => {
  if (DB_SKIP) return;
  await repositories.truncateAll(); // isolation between cases
});

after(async () => {
  if (DB_SKIP) return;
  await pool.close();
});

test(
  "upsertShops then joinPresale/joinHistory round-trip the stored rows",
  { skip: DB_SKIP },
  async () => {
    await repositories.upsertShops([
      {
        customerCode: "12345",
        shopName: "ร้านสมชาย",
        location: { lat: 13.72, lng: 100.53 },
        coordSource: "master",
        serviceTimeMin: 10,
        openTime: "08:00",
        closeTime: "17:00",
      },
    ]);
    await repositories.insertPresaleEntries([
      {
        customerCode: "12345",
        customerName: "ร้านสมชาย",
        deliveryDate: "2026-02-01",
        demand: 20,
      },
    ]);
    await repositories.insertHistoryEntries([
      {
        customerCode: "12345",
        customerName: "ร้านสมชาย",
        timeVisit: "2026-01-10T09:15:00",
        quantity: 12,
      },
    ]);

    const presaleJoined = await repositories.joinPresale();
    assert.equal(presaleJoined.length, 1);
    assert.equal(presaleJoined[0].presale.customerCode, "12345");
    assert.equal(presaleJoined[0].presale.demand, 20);
    assert.deepEqual(presaleJoined[0].shop.location, { lat: 13.72, lng: 100.53 });
    assert.equal(presaleJoined[0].shop.serviceTimeMin, 10);
    assert.equal(presaleJoined[0].shop.openTime, "08:00");
    assert.equal(presaleJoined[0].shop.closeTime, "17:00");

    const historyJoined = await repositories.joinHistory();
    assert.equal(historyJoined.length, 1);
    assert.equal(historyJoined[0].history.customerCode, "12345");
    assert.equal(historyJoined[0].history.quantity, 12);
    assert.deepEqual(historyJoined[0].shop.location, { lat: 13.72, lng: 100.53 });
  }
);

test(
  "a repeat upsertShops on the same customer_code updates rather than duplicates (ON CONFLICT)",
  { skip: DB_SKIP },
  async () => {
    await repositories.upsertShops([
      {
        customerCode: "S1",
        shopName: "First Name",
        location: { lat: 1, lng: 2 },
        coordSource: "master",
        serviceTimeMin: 5,
        openTime: "07:00",
        closeTime: "15:00",
      },
    ]);
    // Same customer_code, different values -> should UPDATE the existing row.
    await repositories.upsertShops([
      {
        customerCode: "S1",
        shopName: "Second Name",
        location: { lat: 3, lng: 4 },
        coordSource: "master",
        serviceTimeMin: 9,
        openTime: "09:00",
        closeTime: "18:00",
      },
    ]);

    const total = await pool.query("SELECT count(*)::int AS n FROM shops");
    assert.equal(total.rows[0].n, 1); // updated, NOT duplicated

    const { rows } = await pool.query(
      "SELECT shop_name, lat, lng, service_time_min FROM shops WHERE customer_code = $1",
      ["S1"]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].shop_name, "Second Name");
    assert.equal(rows[0].lat, 3);
    assert.equal(rows[0].lng, 4);
    assert.equal(rows[0].service_time_min, 9);
  }
);

test(
  "master columns win in the join: coords/service_time/open/close come from Shop_Master (Req 2.5)",
  { skip: DB_SKIP },
  async () => {
    await repositories.upsertShops([
      {
        customerCode: "M1",
        shopName: "Master Shop",
        location: { lat: 13.5, lng: 100.1 },
        coordSource: "master",
        serviceTimeMin: 25,
        openTime: "06:30",
        closeTime: "20:00",
      },
    ]);
    await repositories.insertPresaleEntries([
      {
        customerCode: "M1",
        customerName: "Master Shop",
        deliveryDate: "2026-02-02",
        demand: 7,
      },
    ]);
    await repositories.insertHistoryEntries([
      {
        customerCode: "M1",
        customerName: "Master Shop",
        timeVisit: "2026-01-11T08:00:00",
        quantity: 3,
      },
    ]);

    const [presale] = await repositories.joinPresale();
    assert.deepEqual(presale.shop.location, { lat: 13.5, lng: 100.1 });
    assert.equal(presale.shop.serviceTimeMin, 25);
    assert.equal(presale.shop.openTime, "06:30");
    assert.equal(presale.shop.closeTime, "20:00");
    assert.equal(presale.shop.coordSource, "master");

    const [history] = await repositories.joinHistory();
    assert.deepEqual(history.shop.location, { lat: 13.5, lng: 100.1 });
    assert.equal(history.shop.serviceTimeMin, 25);
    assert.equal(history.shop.openTime, "06:30");
    assert.equal(history.shop.closeTime, "20:00");
  }
);
