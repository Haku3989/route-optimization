/**
 * Integration tests for the raw-SQL repository layer (task 3.4).
 *
 * These exercise the REAL `pg` layer and SQL against a Postgres database and are
 * SKIPPED cleanly when `TEST_DATABASE_URL` is not set (see
 * tests/helpers/dbIntegration.js — deliberately a SEPARATE variable from the
 * app's `DATABASE_URL`, so running these against your real dev database
 * requires an explicit, separate opt-in). When a test DB is configured, the
 * schema is applied once (before) and every table is truncated between tests
 * (beforeEach) for isolation; the pool is closed after.
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

test(
  "distinctHistoryFilterValues scopes each column by every OTHER active filter (cascading dropdowns)",
  { skip: DB_SKIP },
  async () => {
    await repositories.insertHistoryEntries([
      {
        customerCode: "H1",
        timeVisit: "2026-01-10T09:00:00",
        dcName: "DC_A",
        storeName: "Store A1",
        storeGroup: "Group X",
      },
      {
        customerCode: "H2",
        timeVisit: "2026-01-10T09:00:00",
        dcName: "DC_A",
        storeName: "Store A2",
        storeGroup: "Group Y",
      },
      {
        customerCode: "H3",
        timeVisit: "2026-01-10T09:00:00",
        dcName: "DC_B",
        storeName: "Store B1",
        storeGroup: "Group X",
      },
    ]);

    // No active filters -> every column lists every distinct value.
    const unfiltered = await repositories.distinctHistoryFilterValues();
    assert.deepEqual(unfiltered.dcName, ["DC_A", "DC_B"]);
    assert.deepEqual(unfiltered.storeName, ["Store A1", "Store A2", "Store B1"]);

    // Selecting DC_A narrows StoreName to DC_A's own stores...
    const scopedToDcA = await repositories.distinctHistoryFilterValues({ dcName: "DC_A" });
    assert.deepEqual(scopedToDcA.storeName, ["Store A1", "Store A2"]);
    assert.deepEqual(scopedToDcA.storeGroup, ["Group X", "Group Y"]);
    // ...but DC_Name's OWN list is never self-scoped, so both DCs still show.
    assert.deepEqual(scopedToDcA.dcName, ["DC_A", "DC_B"]);

    // Selecting DC_A + Store A1 narrows StoreGroup down to just Group X.
    const scopedToStoreA1 = await repositories.distinctHistoryFilterValues({
      dcName: "DC_A",
      storeName: "Store A1",
    });
    assert.deepEqual(scopedToStoreA1.storeGroup, ["Group X"]);
  }
);

test(
  "historyOverview groups visit/customer counts by DC_Name and by StoreName",
  { skip: DB_SKIP },
  async () => {
    await repositories.insertHistoryEntries([
      // DC_A / Store A1: 2 visits, 2 distinct customers.
      { customerCode: "C1", timeVisit: "2026-01-10T09:00:00", dcName: "DC_A", storeName: "Store A1" },
      { customerCode: "C2", timeVisit: "2026-01-10T09:05:00", dcName: "DC_A", storeName: "Store A1" },
      // DC_A / Store A2: 2 visits, but only 1 distinct customer (C1 again).
      { customerCode: "C1", timeVisit: "2026-01-11T09:00:00", dcName: "DC_A", storeName: "Store A2" },
      { customerCode: "C3", timeVisit: "2026-01-11T09:05:00", dcName: "DC_A", storeName: "Store A2" },
      // DC_B / Store B1: 1 visit, 1 customer.
      { customerCode: "C4", timeVisit: "2026-01-12T09:00:00", dcName: "DC_B", storeName: "Store B1" },
    ]);

    const overview = await repositories.historyOverview();

    // byDc: DC_A has 4 visits across {C1,C2,C3} = 3 distinct customers; DC_B has 1/1.
    const dcA = overview.byDc.find((d) => d.dcName === "DC_A");
    const dcB = overview.byDc.find((d) => d.dcName === "DC_B");
    assert.deepEqual(dcA, { dcName: "DC_A", visits: 4, customers: 3 });
    assert.deepEqual(dcB, { dcName: "DC_B", visits: 1, customers: 1 });

    // byStore: each store's own visit/customer counts, with its owning DC attached.
    const storeA1 = overview.byStore.find((s) => s.storeName === "Store A1");
    const storeA2 = overview.byStore.find((s) => s.storeName === "Store A2");
    assert.deepEqual(storeA1, { storeName: "Store A1", dcName: "DC_A", visits: 2, customers: 2 });
    assert.deepEqual(storeA2, { storeName: "Store A2", dcName: "DC_A", visits: 2, customers: 2 });

    // Sorted busiest-first (by customers desc): DC_A (3) before DC_B (1).
    assert.deepEqual(overview.byDc.map((d) => d.dcName), ["DC_A", "DC_B"]);
  }
);

test(
  "findHistoryOnlyCustomers / findUnresolvedShops / hasAllWorkbookTypes power the backfill job",
  { skip: DB_SKIP },
  async () => {
    assert.equal(await repositories.hasAllWorkbookTypes(), false);

    await repositories.upsertShops([
      {
        customerCode: "S1", // has a shop row already, but coords never resolved
        shopName: "Unresolved Shop",
        location: null,
        coordSource: "unresolved",
        serviceTimeMin: 12,
        openTime: "09:00",
        closeTime: "17:00",
      },
    ]);
    await repositories.insertHistoryEntries([
      // H1: has a shop row (S1) — must NOT show up as history-only.
      { customerCode: "S1", timeVisit: "2026-01-10T09:00:00", storeName: "Unresolved Shop" },
      // H2/H3: no shop row at all — history-only, sharing one store name.
      { customerCode: "H2", timeVisit: "2026-01-10T09:00:00", storeName: "New Store", customerName: "Shop H2" },
      { customerCode: "H3", timeVisit: "2026-01-10T09:05:00", storeName: "New Store", customerName: "Shop H3" },
    ]);
    await repositories.insertPresaleEntries([
      { customerCode: "P1", customerName: "Presale One", deliveryDate: "2026-01-10", demand: 1 },
    ]);

    assert.equal(await repositories.hasAllWorkbookTypes(), true);

    const historyOnly = await repositories.findHistoryOnlyCustomers();
    assert.deepEqual(
      historyOnly.map((c) => c.customerCode).sort(),
      ["H2", "H3"]
    );
    for (const c of historyOnly) assert.equal(c.geocodeQuery, "New Store");

    const unresolvedShops = await repositories.findUnresolvedShops();
    assert.equal(unresolvedShops.length, 1);
    assert.equal(unresolvedShops[0].customerCode, "S1");
    assert.equal(unresolvedShops[0].geocodeQuery, "Unresolved Shop");
    assert.equal(unresolvedShops[0].serviceTimeMin, 12);
    assert.equal(unresolvedShops[0].openTime, "09:00");
  }
);

test(
  "distinctHistoryDates returns only days that have data, scoped by active filters",
  { skip: DB_SKIP },
  async () => {
    await repositories.insertHistoryEntries([
      { customerCode: "C1", timeVisit: "09:00", invoiceDate: "2026-01-10", dcName: "DC_A", storeName: "Store A1" },
      { customerCode: "C2", timeVisit: "09:00", invoiceDate: "2026-01-11", dcName: "DC_A", storeName: "Store A1" },
      { customerCode: "C3", timeVisit: "09:00", invoiceDate: "2026-01-12", dcName: "DC_A", storeName: "Store A2" },
      { customerCode: "C4", timeVisit: "09:00", invoiceDate: "2026-01-20", dcName: "DC_B", storeName: "Store B1" },
    ]);

    const all = await repositories.distinctHistoryDates();
    assert.deepEqual(all, ["2026-01-10", "2026-01-11", "2026-01-12", "2026-01-20"]);

    const scopedToDcA = await repositories.distinctHistoryDates({ dcName: "DC_A" });
    assert.deepEqual(scopedToDcA, ["2026-01-10", "2026-01-11", "2026-01-12"]);

    const scopedToStoreA1 = await repositories.distinctHistoryDates({ storeName: "Store A1" });
    assert.deepEqual(scopedToStoreA1, ["2026-01-10", "2026-01-11"]);
  }
);
