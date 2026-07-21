import test from "node:test";
import assert from "node:assert/strict";

import {
  DC_LIST,
  extractDcCode,
  findDcByCode,
  resolveDcByName,
  resolveDepotForStore,
} from "../src/data/dcList.js";

// ---------------------------------------------------------------------------
// DC_LIST integrity — every entry has a well-formed 4-digit code, unique
// across the list, with finite coordinates.
// ---------------------------------------------------------------------------

test("DC_LIST: every entry has a unique 4-digit code and finite coordinates", () => {
  assert.ok(DC_LIST.length > 0);
  const codes = new Set();
  for (const dc of DC_LIST) {
    assert.match(dc.code, /^\d{4}$/, `code ${dc.code} must be exactly 4 digits`);
    assert.ok(!codes.has(dc.code), `duplicate DC code ${dc.code}`);
    codes.add(dc.code);
    assert.equal(typeof dc.name, "string");
    assert.ok(dc.name.length > 0);
    assert.ok(Number.isFinite(dc.lat));
    assert.ok(Number.isFinite(dc.lng));
  }
});

// ---------------------------------------------------------------------------
// extractDcCode
// ---------------------------------------------------------------------------

test("extractDcCode: pulls the leading 4 digits from a StoreName or DC_Name", () => {
  assert.equal(extractDcCode("120210 หน่วย ลิบ บางบัวทอง"), "1202");
  assert.equal(extractDcCode("1202 บางบัวทอง"), "1202");
  assert.equal(extractDcCode("  1103 พระยาสุเรนทร์  "), "1103");
});

test("extractDcCode: null for non-strings, blanks, and short/no leading digits", () => {
  assert.equal(extractDcCode(null), null);
  assert.equal(extractDcCode(undefined), null);
  assert.equal(extractDcCode(123), null);
  assert.equal(extractDcCode(""), null);
  assert.equal(extractDcCode("   "), null);
  assert.equal(extractDcCode("12 บางบัวทอง"), null); // only 2 leading digits
  assert.equal(extractDcCode("ABC1202"), null); // does not START with digits
});

// ---------------------------------------------------------------------------
// findDcByCode / resolveDcByName
// ---------------------------------------------------------------------------

test("findDcByCode: resolves a known code and returns null for an unknown one", () => {
  const dc = findDcByCode("1202");
  assert.ok(dc);
  assert.equal(dc.code, "1202");
  assert.equal(dc.name, "บางบัวทอง");
  assert.equal(findDcByCode("9999"), null);
  assert.equal(findDcByCode(null), null);
});

test("resolveDcByName: resolves every DC from its own canonical DC_Name string", () => {
  for (const dc of DC_LIST) {
    const resolved = resolveDcByName(`${dc.code} ${dc.name}`);
    assert.deepEqual(resolved, dc);
  }
});

test("resolveDcByName: resolves a longer StoreName via its leading DC code", () => {
  const resolved = resolveDcByName("120210 หน่วย ลิบ บางบัวทอง");
  assert.ok(resolved);
  assert.equal(resolved.code, "1202");
});

test("resolveDcByName: null when the code has no matching DC, or none can be extracted", () => {
  assert.equal(resolveDcByName("999910 unknown store"), null);
  assert.equal(resolveDcByName(""), null);
  assert.equal(resolveDcByName(null), null);
});

// ---------------------------------------------------------------------------
// resolveDepotForStore — StoreName preferred, DC_Name fallback
// ---------------------------------------------------------------------------

test("resolveDepotForStore: prefers storeName when it resolves", () => {
  const dc = resolveDepotForStore({
    storeName: "120210 หน่วย ลิบ บางบัวทอง",
    dcName: "1103 พระยาสุเรนทร์",
  });
  assert.ok(dc);
  assert.equal(dc.code, "1202"); // storeName wins over a conflicting dcName
});

test("resolveDepotForStore: falls back to dcName when storeName does not resolve", () => {
  const dc = resolveDepotForStore({
    storeName: "not a code",
    dcName: "1103 พระยาสุเรนทร์",
  });
  assert.ok(dc);
  assert.equal(dc.code, "1103");
});

test("resolveDepotForStore: null when neither resolves", () => {
  assert.equal(resolveDepotForStore({ storeName: null, dcName: undefined }), null);
  assert.equal(resolveDepotForStore(), null);
});
