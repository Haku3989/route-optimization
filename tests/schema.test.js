import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  WORKBOOK_SCHEMAS,
  classifyWorkbook,
  validateColumns,
} from "../src/ingestion/schema.js";

const TYPES = Object.keys(WORKBOOK_SCHEMAS); // ["history", "shopMaster", "presale"]

// --- Generators -------------------------------------------------------------
// For a chosen workbook type: remove a NON-EMPTY subset of its required
// columns, keep the rest, optionally sprinkle in some of its optional columns
// and arbitrary extra headers (that can never collide with a required name,
// even after trimming). This exercises validateColumns over the full space of
// "some required column is missing" while proving extra/optional headers never
// mask a missing required column.
const scenarioArb = fc.constantFrom(...TYPES).chain((type) => {
  const { required, optional } = WORKBOOK_SCHEMAS[type];
  const requiredSet = new Set(required);
  return fc.record({
    type: fc.constant(type),
    removed: fc.subarray(required, { minLength: 1 }),
    includeOptional: fc.subarray(optional),
    extras: fc
      .array(fc.string(), { maxLength: 4 })
      // Never let an "extra" header trim down to one of this type's required
      // column names — otherwise it would satisfy a column we deliberately removed.
      .map((arr) => arr.filter((e) => !requiredSet.has(String(e).trim()))),
  });
});

// --- Property 2 -------------------------------------------------------------
// Feature: excel-route-planning, Property 2: Missing required columns are rejected and named
// Validates: Requirements 1.4
test("Property 2: missing required columns are rejected and named", () => {
  fc.assert(
    fc.property(scenarioArb, ({ type, removed, includeOptional, extras }) => {
      const { required } = WORKBOOK_SCHEMAS[type];
      const kept = required.filter((c) => !removed.includes(c));
      const headers = [...kept, ...includeOptional, ...extras];

      const { ok, missing } = validateColumns(type, headers);

      // A workbook missing at least one required column must be rejected...
      assert.equal(ok, false);
      // ...and `missing` must name exactly the removed required columns (as a set).
      assert.deepEqual(new Set(missing), new Set(removed));
      // No duplicates / spurious entries.
      assert.equal(missing.length, removed.length);
    }),
    { numRuns: 200 }
  );
});

// --- Example: full header set validates cleanly (Req 1.4 happy path) --------
test("validateColumns accepts headers containing all required columns", () => {
  for (const type of TYPES) {
    const { required, optional } = WORKBOOK_SCHEMAS[type];
    const headers = [...required, ...optional, "some_extra_column"];
    const { ok, missing } = validateColumns(type, headers);
    assert.equal(ok, true, `expected ${type} to validate`);
    assert.deepEqual(missing, []);
  }
});

// --- Example: header trimming is honoured ------------------------------------
test("validateColumns trims headers before matching", () => {
  const { required } = WORKBOOK_SCHEMAS.history;
  const headers = required.map((c) => `  ${c}  `);
  const { ok, missing } = validateColumns("history", headers);
  assert.equal(ok, true);
  assert.deepEqual(missing, []);
});

// --- Example: unknown type is a programming error ---------------------------
test("validateColumns throws on an unknown workbook type", () => {
  assert.throws(() => validateColumns("nope", ["a", "b"]), /Unknown workbook type/);
});

// --- Example: classifyWorkbook trusts an explicit hint ----------------------
test("classifyWorkbook returns a known hint without inspecting headers", () => {
  // Headers that clearly look like a shopMaster, but the hint wins.
  const headers = WORKBOOK_SCHEMAS.shopMaster.required;
  assert.equal(classifyWorkbook(headers, "presale"), "presale");
});

// --- Example: classifyWorkbook ignores an unknown hint and infers -----------
test("classifyWorkbook ignores an unknown hint and infers from headers", () => {
  const headers = WORKBOOK_SCHEMAS.presale.required;
  assert.equal(classifyWorkbook(headers, "bogus"), "presale");
});

// --- Example: classifyWorkbook infers each type from its own headers --------
test("classifyWorkbook infers the type from a full required header set", () => {
  for (const type of TYPES) {
    const headers = [
      ...WORKBOOK_SCHEMAS[type].required,
      ...WORKBOOK_SCHEMAS[type].optional,
    ];
    assert.equal(classifyWorkbook(headers), type);
  }
});

// --- Example: history vs shopMaster are distinguished by code-column casing --
test("classifyWorkbook distinguishes history from shopMaster by header casing", () => {
  assert.equal(classifyWorkbook(["Customer_Code", "TIME_VISIT", "จำนวนลง"]), "history");
  assert.equal(
    classifyWorkbook([
      "Customer_code",
      "lat",
      "long",
      "service_time_min",
      "open_time",
      "close_time",
    ]),
    "shopMaster"
  );
});
