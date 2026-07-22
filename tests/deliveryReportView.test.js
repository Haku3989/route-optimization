import test from "node:test";
import assert from "node:assert/strict";

import { summarizeDeliveryReport } from "../public/deliveryReportView.js";

test("summarizeDeliveryReport handles the { message } guard shape", () => {
  const vm = summarizeDeliveryReport({ message: "select a single day" });
  assert.equal(vm.isMessage, true);
  assert.equal(vm.message, "select a single day");
  assert.deepEqual(vm.stores, []);
  assert.deepEqual(vm.rows, []);
  assert.deepEqual(vm.excluded, []);
  assert.deepEqual(vm.skippedStores, []);
  assert.equal(vm.totals, null);
});

test("summarizeDeliveryReport handles a null/undefined result", () => {
  assert.equal(summarizeDeliveryReport(null).isMessage, true);
  assert.equal(summarizeDeliveryReport(undefined).isMessage, true);
});

test("summarizeDeliveryReport flattens a full report response", () => {
  const result = {
    day: "2026-07-19",
    toleranceMin: 15,
    stores: [
      {
        storeName: "Store A",
        dcName: "DC 1",
        totalRecords: 10,
        routableDeliveries: 8,
        unroutableCount: 2,
        unparseableTimeCount: 0,
        early: 2,
        onTime: 5,
        late: 1,
        earlyPct: 25,
        onTimePct: 62.5,
        latePct: 12.5,
        avgDeviationMin: 3.456,
      },
    ],
    totals: {
      totalRecords: 10,
      routableDeliveries: 8,
      unroutableCount: 2,
      unparseableTimeCount: 0,
      early: 2,
      onTime: 5,
      late: 1,
      earlyPct: 25,
      onTimePct: 62.5,
      latePct: 12.5,
      avgDeviationMin: 3.456,
    },
    rows: [
      {
        storeName: "Store A",
        dcName: "DC 1",
        customerCode: "C1",
        customer: "Shop 1",
        actualEta: "2026-07-19T04:05:00.000Z",
        optimizedEta: "2026-07-19T04:00:00.000Z",
        deviationMin: 5,
        category: "on_time",
      },
    ],
    excluded: [
      { storeName: "Store A", dcName: "DC 1", customerCode: "C2", customer: "Shop 2", reason: "no resolvable shop coordinates" },
    ],
    skippedStores: [{ storeName: "Store B", dcName: "DC 2", recordCount: 200, reason: "too many customers" }],
  };

  const vm = summarizeDeliveryReport(result);
  assert.equal(vm.isMessage, false);
  assert.equal(vm.day, "2026-07-19");
  assert.equal(vm.toleranceMin, 15);
  assert.equal(vm.stores.length, 1);
  assert.equal(vm.stores[0].avgDeviationMin, 3.46);
  assert.equal(vm.totals.routableDeliveries, 8);
  assert.equal(vm.rows.length, 1);
  assert.equal(vm.rows[0].category, "on_time");
  assert.equal(vm.excluded.length, 1);
  assert.equal(vm.excluded[0].reason, "no resolvable shop coordinates");
  assert.equal(vm.skippedStores.length, 1);
  assert.equal(vm.skippedStores[0].reason, "too many customers");
});

test("summarizeDeliveryReport is defensive against missing/malformed arrays", () => {
  const vm = summarizeDeliveryReport({ day: "2026-07-19", toleranceMin: 15 });
  assert.equal(vm.isMessage, false);
  assert.deepEqual(vm.stores, []);
  assert.deepEqual(vm.rows, []);
  assert.deepEqual(vm.excluded, []);
  assert.deepEqual(vm.skippedStores, []);
  assert.equal(vm.totals, null);
});
