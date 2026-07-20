import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import fc from "fast-check";

import { parseWorkbook, IngestionError } from "../src/ingestion/excelParser.js";

// --- Generators -------------------------------------------------------------
// Header names: non-empty, whitespace-free tokens so the trimmed header text
// round-trips unchanged. Unique so each column maps to a distinct key.
const HEADER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split("");
const headerNameArb = fc
  .array(fc.constantFrom(...HEADER_CHARS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));

// Cell values: non-empty strings or integers so every data row carries at
// least one value (a fully-empty row would not survive an xlsx round-trip).
const CELL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ก-ฮ".split("");
const cellArb = fc.oneof(
  fc
    .array(fc.constantFrom(...CELL_CHARS), { minLength: 1, maxLength: 12 })
    .map((chars) => chars.join("").trim() || "x"),
  fc.integer({ min: 1, max: 100000 })
);

// A grid = unique headers + N data rows, each row exactly as wide as headers.
const gridArb = fc
  .uniqueArray(headerNameArb, { minLength: 1, maxLength: 6 })
  .chain((headers) =>
    fc.record({
      headers: fc.constant(headers),
      rows: fc.array(
        fc.array(cellArb, {
          minLength: headers.length,
          maxLength: headers.length,
        }),
        { minLength: 0, maxLength: 12 }
      ),
    })
  );

// --- Property 1 -------------------------------------------------------------
// Feature: excel-route-planning, Property 1: Parse preserves headers and row count
// Validates: Requirements 1.2
test("Property 1: parse preserves headers and row count", async () => {
  await fc.assert(
    fc.asyncProperty(gridArb, async ({ headers, rows }) => {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet("Data");
      ws.addRow(headers);
      for (const row of rows) ws.addRow(row);
      const buffer = await workbook.xlsx.writeBuffer();

      const parsed = await parseWorkbook(Buffer.from(buffer));

      assert.deepEqual(parsed.headers, headers);
      assert.equal(parsed.rowCount, rows.length);
      assert.equal(parsed.rows.length, rows.length);
    }),
    { numRuns: 100 }
  );
});

// --- Example: known workbook parses to expected headers/rows (Req 1.1, 1.2) --
test("parseWorkbook reads the first worksheet into keyed rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Sheet1");
  ws.addRow(["Customer_Code", "TIME_VISIT", "จำนวนลง"]);
  ws.addRow(["12345", "2026-01-10T09:15:00", 12]);
  ws.addRow(["67890", "2026-01-10T10:30:00", 8]);
  // A second sheet must be ignored (only the first worksheet is read).
  const other = workbook.addWorksheet("Ignored");
  other.addRow(["Nope"]);
  const buffer = await workbook.xlsx.writeBuffer();

  const { headers, rows, rowCount } = await parseWorkbook(Buffer.from(buffer));

  assert.deepEqual(headers, ["Customer_Code", "TIME_VISIT", "จำนวนลง"]);
  assert.equal(rowCount, 2);
  assert.equal(rows[0].Customer_Code, "12345");
  assert.equal(rows[0]["จำนวนลง"], 12);
  assert.equal(rows[1].Customer_Code, "67890");
});

// --- Example test for unreadable buffer (Task 4.3) --------------------------
// Validates: Requirement 1.3
test("parseWorkbook rejects an unreadable (non-xlsx) buffer with IngestionError", async () => {
  const notAWorkbook = Buffer.from("not a workbook");

  await assert.rejects(
    () => parseWorkbook(notAWorkbook),
    (err) => {
      assert.ok(err instanceof IngestionError, "expected an IngestionError");
      assert.match(err.message, /not a readable \.xlsx workbook/i);
      assert.equal(err.status, 400);
      return true;
    }
  );
});
