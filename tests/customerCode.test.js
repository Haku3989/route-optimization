import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { parseCustomerCode } from "../src/ingestion/customerCode.js";

// --- Generators -------------------------------------------------------------
// A Customer_Code is a non-empty run of non-whitespace characters (alphanumeric
// plus a couple of code-friendly separators), matching the real code tokens.
const CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const codeArb = fc
  .array(fc.constantFrom(...CODE_CHARS), { minLength: 1, maxLength: 10 })
  .map((chars) => chars.join(""));

// A name is one to three non-empty words (Latin + a handful of Thai glyphs)
// joined by single spaces — non-blank, no leading/trailing whitespace, but may
// contain internal spaces so multi-word shop names are exercised.
const WORD_CHARS =
  "ABCDEFabcdef0123456789กขคงจฉรานสมชยทองพลาซ่า".split("");
const wordArb = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));
const nameArb = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(" "));

// --- Property 10 (parsing half) ---------------------------------------------
// Feature: excel-route-planning, Property 10: Presale code parsing round-trips and produces well-formed orders
// Validates: Requirements 5.1
test("Property 10 (parsing half): parseCustomerCode recovers the leading code", () => {
  fc.assert(
    fc.property(codeArb, nameArb, (code, name) => {
      const customerName = `${code} ${name}`;
      const parsed = parseCustomerCode(customerName);
      assert.equal(parsed.code, code);
    }),
    { numRuns: 200 }
  );
});

// --- Example: canonical "<code> <name>" split (Req 5.1) ---------------------
test("parseCustomerCode splits the leading code from the name", () => {
  assert.deepEqual(parseCustomerCode("12345 ร้านสมชาย"), {
    code: "12345",
    name: "ร้านสมชาย",
  });
});

// --- Example: multi-word names keep the whole remainder as the name ---------
test("parseCustomerCode keeps a multi-word name intact", () => {
  assert.deepEqual(parseCustomerCode("A1 Big C สาขา 1"), {
    code: "A1",
    name: "Big C สาขา 1",
  });
});

// --- Example: surrounding whitespace is trimmed from both parts -------------
test("parseCustomerCode trims surrounding whitespace", () => {
  assert.deepEqual(parseCustomerCode("   99  ร้านทดสอบ   "), {
    code: "99",
    name: "ร้านทดสอบ",
  });
});

// --- Example: a single token has no code prefix -----------------------------
test("parseCustomerCode returns code:null for a single token", () => {
  assert.deepEqual(parseCustomerCode("ร้านเดี่ยว"), {
    code: null,
    name: "ร้านเดี่ยว",
  });
});

// --- Example: empty / nullish input -----------------------------------------
test("parseCustomerCode returns code:null for empty or nullish input", () => {
  assert.deepEqual(parseCustomerCode(""), { code: null, name: "" });
  assert.deepEqual(parseCustomerCode("   "), { code: null, name: "" });
  assert.deepEqual(parseCustomerCode(null), { code: null, name: "" });
  assert.deepEqual(parseCustomerCode(undefined), { code: null, name: "" });
});
