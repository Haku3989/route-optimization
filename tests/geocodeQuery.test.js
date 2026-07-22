import test from "node:test";
import assert from "node:assert/strict";
import { buildGeocodeQuery, cleanCustomerName, dcArea } from "../src/routing/geocodeQuery.js";

test("cleanCustomerName: strips a trailing '- NNN' code inside parens, keeps the Thai branch text", () => {
  assert.equal(
    cleanCustomerName("CJ Express (สาขา แฟลตทหารเรือโพธิ์ทองจุด 2 - 1110)"),
    "CJ Express สาขา แฟลตทหารเรือโพธิ์ทองจุด 2"
  );
});

test("cleanCustomerName: strips a leading 'NNN-' code inside parens, keeps the Thai branch text", () => {
  assert.equal(cleanCustomerName("Tops Daily (2411-สาขาลาดพร้าว 18 แยก 1)"), "Tops Daily สาขาลาดพร้าว 18 แยก 1");
});

test("cleanCustomerName: drops a bare alphanumeric-code parenthetical entirely", () => {
  assert.equal(cleanCustomerName("maxmart Max Mart ถนนฉลองกรุง (MD92)"), "maxmart Max Mart ถนนฉลองกรุง");
});

test("cleanCustomerName: never collapses a whole name down to just the chain brand — that resolves to the wrong branch", () => {
  const cleaned = cleanCustomerName("CJ Express (สาขา ตลาดน้ำตาลพัฒนา - 0674)");
  assert.notEqual(cleaned, "CJ Express", "stripping must keep the Thai branch text, not just the brand name");
  assert.equal(cleaned, "CJ Express สาขา ตลาดน้ำตาลพัฒนา");
});

test("cleanCustomerName: a name with no parens/codes passes through unchanged", () => {
  assert.equal(cleanCustomerName("Shop 1"), "Shop 1");
});

test("cleanCustomerName: null/blank input returns null", () => {
  assert.equal(cleanCustomerName(null), null);
  assert.equal(cleanCustomerName(undefined), null);
  assert.equal(cleanCustomerName("   "), null);
});

test("dcArea: strips the DC's leading numeric code, keeps the area name", () => {
  assert.equal(dcArea("1801 พัทยา"), "พัทยา");
  assert.equal(dcArea("1103 พระยาสุเรนทร์"), "พระยาสุเรนทร์");
});

test("dcArea: non-string/missing input returns ''", () => {
  assert.equal(dcArea(null), "");
  assert.equal(dcArea(undefined), "");
});

test("buildGeocodeQuery: combines cleaned customerName with DC area context", () => {
  assert.equal(
    buildGeocodeQuery({ customerName: "7-11 (สาขา หนองบอน - 05607)", dcName: "1801 พัทยา", storeName: "180105 หน่วย ห้า" }),
    "7-11 สาขา หนองบอน พัทยา"
  );
});

test("buildGeocodeQuery: no dcName -> cleaned customerName alone", () => {
  assert.equal(buildGeocodeQuery({ customerName: "Shop 1", storeName: "Shop 1 Branch" }), "Shop 1");
});

test("buildGeocodeQuery: no customerName -> falls back to storeName", () => {
  assert.equal(buildGeocodeQuery({ customerName: null, dcName: "1801 พัทยา", storeName: "New Store" }), "New Store");
});

test("buildGeocodeQuery: no customerName or storeName -> falls back to raw dcName", () => {
  assert.equal(buildGeocodeQuery({ customerName: null, dcName: "1801 พัทยา", storeName: null }), "1801 พัทยา");
});

test("buildGeocodeQuery: nothing usable -> null", () => {
  assert.equal(buildGeocodeQuery({ customerName: null, dcName: null, storeName: null }), null);
  assert.equal(buildGeocodeQuery({}), null);
});
