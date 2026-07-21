import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { WORKBOOK_SCHEMAS } from "../src/ingestion/schema.js";
import {
  mapShopMasterRows,
  mapHistoryRows,
  mapPresaleRows,
} from "../src/ingestion/mappers.js";

const SHOP_REQUIRED = WORKBOOK_SCHEMAS.shopMaster.required;

// --- Generators -------------------------------------------------------------
// A Shop_Master "row plan": valid values for every required column plus a
// (possibly empty) subset of required columns to BLANK. When the blanked subset
// is empty the row is valid (kept); otherwise the row is excluded. Blanks are
// drawn from the three flavours the mapper treats as missing: null, "", "   ".
const blankArb = fc.constantFrom(null, "", "   ");

const shopRowPlanArb = fc.record({
  code: fc
    .array(fc.constantFrom(..."ABCabc0123456789".split("")), {
      minLength: 1,
      maxLength: 8,
    })
    .map((c) => c.join("")),
  lat: fc.integer({ min: -90, max: 90 }),
  long: fc.integer({ min: -180, max: 180 }),
  serviceTime: fc.integer({ min: 0, max: 120 }),
  open: fc.constantFrom("07:30", "08:00", "09:00"),
  close: fc.constantFrom("17:00", "18:00", "20:00"),
  shopName: fc.option(fc.constantFrom("ร้าน A", "Shop B", "ร้านค้าทดสอบ"), {
    nil: undefined,
  }),
  blanked: fc.subarray(SHOP_REQUIRED),
  // One blank flavour per required column (indexed by required-column position).
  blankVals: fc.array(blankArb, {
    minLength: SHOP_REQUIRED.length,
    maxLength: SHOP_REQUIRED.length,
  }),
});

function buildShopRows(plans) {
  const rows = [];
  const excludedRowNumbers = [];

  plans.forEach((plan, i) => {
    const valid = {
      Customer_code: plan.code,
      lat: plan.lat,
      long: plan.long,
      service_time_min: plan.serviceTime,
      open_time: plan.open,
      close_time: plan.close,
    };

    const row = {};
    SHOP_REQUIRED.forEach((col, idx) => {
      row[col] = plan.blanked.includes(col) ? plan.blankVals[idx] : valid[col];
    });
    if (plan.shopName !== undefined) row["shop_name"] = plan.shopName;

    rows.push(row);
    if (plan.blanked.length > 0) excludedRowNumbers.push(i + 2); // 1-based, row 1 = header
  });

  return { rows, excludedRowNumbers };
}

// --- Property 3 -------------------------------------------------------------
// Feature: excel-route-planning, Property 3: Row mapping excludes invalid rows, conserves the rest, and yields well-formed records
// Validates: Requirements 1.5, 1.6, 1.8
test("Property 3: row mapping conserves rows and yields well-formed shop records", () => {
  fc.assert(
    fc.property(fc.array(shopRowPlanArb, { maxLength: 15 }), (plans) => {
      const { rows, excludedRowNumbers } = buildShopRows(plans);
      const { records, warnings } = mapShopMasterRows(rows);

      // Conservation (Req 1.5, 1.6): mapped + excluded == total row count.
      assert.equal(records.length + excludedRowNumbers.length, rows.length);

      // Every excluded row is recorded by its worksheet row number, and there
      // is exactly one warning per excluded row.
      assert.equal(warnings.length, excludedRowNumbers.length);
      const warnedRows = new Set(warnings.map((w) => w.row));
      for (const rowNumber of excludedRowNumbers) {
        assert.ok(
          warnedRows.has(rowNumber),
          `expected a warning for worksheet row ${rowNumber}`
        );
      }

      // Every mapped Shop_Master record is well-formed (Req 1.8): a shop id,
      // a coordinates field, a Session_Duration, and a Working_Time.
      for (const rec of records) {
        assert.ok(
          typeof rec.customerCode === "string" && rec.customerCode !== "",
          "record exposes a non-empty shop identifier"
        );
        assert.ok(
          rec.coordinates && typeof rec.coordinates === "object",
          "record exposes a coordinates field"
        );
        assert.ok("serviceTimeMin" in rec, "record exposes Session_Duration");
        assert.ok("openTime" in rec, "record exposes Working_Time start");
        assert.ok("closeTime" in rec, "record exposes Working_Time end");
      }
    }),
    { numRuns: 100 }
  );
});

// --- Task 6.5: warning-sink failure -----------------------------------------
// Validates: Requirement 1.7
test("mapping completes remaining rows even when the warnings sink throws", () => {
  const rows = [
    {
      Customer_code: "A1",
      lat: 13.7,
      long: 100.5,
      service_time_min: 10,
      open_time: "08:00",
      close_time: "17:00",
    }, // valid
    {
      Customer_code: "", // blank required -> would trigger a warning
      lat: 13.7,
      long: 100.5,
      service_time_min: 10,
      open_time: "08:00",
      close_time: "17:00",
    }, // excluded
    {
      Customer_code: "A3",
      lat: 13.8,
      long: 100.6,
      service_time_min: 5,
      open_time: "09:00",
      close_time: "18:00",
    }, // valid
  ];

  const throwingSink = {
    push() {
      throw new Error("warnings sink is broken");
    },
  };

  // The throwing sink must not stop the two valid rows from being mapped.
  const { records } = mapShopMasterRows(rows, throwingSink);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.customerCode),
    ["A1", "A3"]
  );
});

// --- Example: Shop_Master field shaping -------------------------------------
test("mapShopMasterRows shapes records to the ShopRecord model", () => {
  const { records, warnings } = mapShopMasterRows([
    {
      Customer_code: " 12345 ",
      shop_name: " ร้านสมชาย ",
      lat: 13.72,
      long: 100.53,
      service_time_min: 10,
      open_time: "08:00",
      close_time: "17:00",
    },
  ]);

  assert.equal(warnings.length, 0);
  assert.deepEqual(records[0], {
    customerCode: "12345",
    shopName: "ร้านสมชาย",
    coordinates: { lat: 13.72, long: 100.53 },
    serviceTimeMin: 10,
    openTime: "08:00",
    closeTime: "17:00",
  });
});

// --- Example: Presale field shaping (code parsed, demand from จำนวน Presale) -
test("mapPresaleRows parses the code and reads demand from จำนวน Presale", () => {
  const { records, warnings } = mapPresaleRows([
    {
      CustomerName: "12345 ร้านสมชาย",
      DELIVERY_DATE: "2026-02-01",
      "จำนวน Presale": 20,
    },
    {
      // Missing demand -> excluded, warned by row number, id from the code.
      CustomerName: "67890 ร้านสมหญิง",
      DELIVERY_DATE: "2026-02-02",
      "จำนวน Presale": "",
    },
  ]);

  assert.deepEqual(records, [
    {
      customerCode: "12345",
      customerName: "ร้านสมชาย",
      deliveryDate: "2026-02-01",
      demand: 20,
      dcName: null,
      storeName: null,
      storeGroup: null,
      storeArea: null,
      customerType: null,
    },
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].row, 3); // second data row -> worksheet row 3
  assert.equal(warnings[0].id, "67890");
});

// --- Example: Presale optional categorical columns are captured when present -
test("mapPresaleRows captures the optional DC/store/group/area/type columns when present", () => {
  const { records, warnings } = mapPresaleRows([
    {
      CustomerName: "12345 ร้านสมชาย",
      DELIVERY_DATE: "2026-02-01",
      "จำนวน Presale": 20,
      DC_Name: "DC Bangkok",
      StoreName: "SALES-01",
      StoreGroup: "MT",
      "Store Area": "Central",
      CustomerType: "KA",
    },
  ]);

  assert.equal(warnings.length, 0);
  assert.deepEqual(records[0], {
    customerCode: "12345",
    customerName: "ร้านสมชาย",
    deliveryDate: "2026-02-01",
    demand: 20,
    dcName: "DC Bangkok",
    storeName: "SALES-01",
    storeGroup: "MT",
    storeArea: "Central",
    customerType: "KA",
  });
});

// --- Example: History field shaping (quantity from จำนวนลง) ------------------
test("mapHistoryRows shapes records and reads quantity from จำนวนลง", () => {
  const { records, warnings } = mapHistoryRows([
    {
      Customer_Code: "12345",
      Customer_Name: "ร้านสมชาย",
      DC_Name: "DC Bangkok",
      StoreName: "SALES-01",
      InvoiceDate: "2026-01-10",
      TIME_VISIT: "2026-01-10T09:15:00",
      VISIT_TYPE: "M1",
      StoreGroup: "MT",
      "Store Area": "Central",
      CustomerType: "KA",
      "จำนวนลง": 12,
    },
  ]);

  assert.equal(warnings.length, 0);
  assert.deepEqual(records[0], {
    customerCode: "12345",
    customerName: "ร้านสมชาย",
    dcName: "DC Bangkok",
    storeName: "SALES-01",
    invoiceDate: "2026-01-10",
    timeVisit: "2026-01-10T09:15:00",
    visitType: "M1",
    storeGroup: "MT",
    storeArea: "Central",
    customerType: "KA",
    quantity: 12,
  });
});
