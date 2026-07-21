/**
 * Distribution Center (DC) reference list + store-to-DC resolution.
 *
 * Sourced from the "dc list.xlsx" workbook (columns: DC_Name, lat, long). Each
 * `DC_Name` value is a 4-digit DC code followed by the DC's Thai name, e.g.
 * `"1202 บางบัวทอง"`.
 *
 * The same 4-digit-code convention is used by `StoreName` (e.g.
 * `"120210 หน่วย ลิบ บางบัวทอง"` — the store's own longer code embeds its DC's
 * code as the FIRST 4 digits) and by the History workbook's `DC_Name` column
 * (which is exactly one of the strings below). So a single rule —
 * "the first 4 digits identify the DC" — resolves a depot location from either
 * field, used globally wherever a route needs its start/end point:
 *   - Presale planning: each vehicle IS a store (see
 *     `presaleService.resolveFleet`), so its route starts and ends at that
 *     store's DC.
 *   - History comparison: the comparison's single notional route starts and
 *     ends at the DC of the filtered StoreName/DC_Name, when one is selected.
 */

/**
 * @typedef {{ code:string, name:string, lat:number, lng:number }} DcEntry
 */

/** @type {DcEntry[]} */
export const DC_LIST = [
  { code: "1103", name: "พระยาสุเรนทร์", lat: 13.82031, lng: 100.6999429 },
  { code: "1302", name: "ทุ่งครุ", lat: 13.6171214, lng: 100.5029627 },
  { code: "1303", name: "ตลิ่งชัน", lat: 13.765172, lng: 100.452255 },
  { code: "1101", name: "ศรีนครินทร์", lat: 13.74329, lng: 100.642309 },
  { code: "1703", name: "โคราช", lat: 15.054926, lng: 102.160437 },
  { code: "1201", name: "ประชาชื่น", lat: 13.836697, lng: 100.536274 },
  { code: "1104", name: "กิ่งแก้ว", lat: 13.704078, lng: 100.736434 },
  { code: "1202", name: "บางบัวทอง", lat: 13.929295, lng: 100.433144 },
  { code: "1105", name: "สมุทรปราการ", lat: 13.5700169, lng: 100.6863238 },
  { code: "1601", name: "เชียงใหม่", lat: 18.769568, lng: 99.069901 },
  { code: "1804", name: "ชลบุรี", lat: 13.249748, lng: 100.994202 },
  { code: "1203", name: "รังสิต", lat: 13.993462, lng: 100.638274 },
  { code: "1704", name: "อุดรธานี", lat: 17.446417, lng: 102.792351 },
  { code: "1603", name: "พิษณุโลก", lat: 16.781086, lng: 100.216591 },
  { code: "1701", name: "ขอนแก่น", lat: 16.387496, lng: 102.8177389 },
  { code: "1702", name: "อุบลราชธานี", lat: 15.195311, lng: 104.832573 },
  { code: "1902", name: "หาดใหญ่", lat: 7.049212, lng: 100.472663 },
  { code: "1801", name: "พัทยา", lat: 12.8644559, lng: 100.9411009 },
  { code: "1602", name: "นครสวรรค์", lat: 15.711826, lng: 100.0659103 },
  { code: "1901", name: "สุราษฎร์", lat: 9.150537, lng: 99.386042 },
  { code: "1301", name: "พระราม 3", lat: 13.685714, lng: 100.524489 },
  { code: "1502", name: "นครปฐม", lat: 13.79451, lng: 100.027477 },
  { code: "1707", name: "สุรินทร์", lat: 14.907739, lng: 103.52953 },
  { code: "1907", name: "นครศรีธรรมราช", lat: 8.437645, lng: 99.973122 },
  { code: "1604", name: "เชียงราย", lat: 19.87304, lng: 99.846304 },
  { code: "1705", name: "สกลนคร", lat: 17.1365409, lng: 104.1391999 },
  { code: "1505", name: "สุพรรณบุรี", lat: 14.551064, lng: 100.135841 },
  { code: "1803", name: "จันทบุรี", lat: 12.589616, lng: 102.084712 },
  { code: "1903", name: "ภูเก็ต", lat: 7.899779, lng: 98.339069 },
  { code: "1706", name: "ร้อยเอ็ด", lat: 16.0678169, lng: 103.673648 },
  { code: "1908", name: "ตรัง", lat: 7.533661, lng: 99.582082 },
  { code: "1802", name: "กบินทร์บุรี", lat: 13.984499, lng: 101.785259 },
  { code: "1709", name: "ชัยภูมิ", lat: 15.8281322, lng: 102.0090051 },
  { code: "1905", name: "กระบี่", lat: 8.091536, lng: 98.889729 },
  { code: "1504", name: "หัวหิน", lat: 12.566153, lng: 99.8938253 },
  { code: "1506", name: "สระบุรี", lat: 14.4532462, lng: 100.9082005 },
  { code: "1805", name: "บางปะกง", lat: 13.4835221, lng: 101.0028033 },
  { code: "1904", name: "ชุมพร", lat: 10.552729, lng: 99.118038 },
  { code: "1606", name: "ตาก", lat: 16.860902, lng: 99.1396379 },
  { code: "1507", name: "กาญจนบุรี", lat: 14.1127579, lng: 99.4942659 },
  { code: "1906", name: "เกาะสมุย", lat: 9.524109, lng: 99.940128 },
  { code: "1503", name: "ลพบุรี", lat: 14.809983, lng: 100.53113 },
  { code: "1501", name: "อยุธยา", lat: 14.376175, lng: 100.585578 },
  { code: "1608", name: "ลำปาง", lat: 16.585353, lng: 99.4370604 },
  { code: "1708", name: "เลย", lat: 17.2952519, lng: 101.7776009 },
  { code: "1607", name: "เพชรบูรณ์", lat: 16.3437, lng: 101.1504111 },
  { code: "1710", name: "มุกดาหาร", lat: 16.5435914, lng: 104.7024121 },
  { code: "1605", name: "แพร่", lat: 18.108027, lng: 100.130674 },
  { code: "1304", name: "สมุทรสาคร", lat: 13.5984793, lng: 100.3089904 },
  { code: "1204", name: "สายไหม", lat: 13.9250508, lng: 100.6563194 },
  { code: "1909", name: "ปัตตานี", lat: 6.8688442, lng: 101.2240441 },
];

/** O(1) code -> entry lookup, built once. */
const DC_BY_CODE = new Map(DC_LIST.map((dc) => [dc.code, dc]));

/**
 * Extract the leading 4-digit DC code from a `StoreName` or `DC_Name` string,
 * e.g. `"120210 หน่วย ลิบ บางบัวทอง"` -> `"1202"`, `"1202 บางบัวทอง"` -> `"1202"`.
 * Returns `null` when `text` is not a string, is blank, or does not start with
 * at least 4 digits.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function extractDcCode(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d{4})/);
  return match ? match[1] : null;
}

/**
 * Look up a DC entry by its 4-digit code.
 * @param {unknown} code
 * @returns {DcEntry|null}
 */
export function findDcByCode(code) {
  if (typeof code !== "string") return null;
  return DC_BY_CODE.get(code) ?? null;
}

/**
 * Resolve a DC entry directly from a `StoreName` or `DC_Name` string (extract
 * the leading code, then look it up). `null` when no 4-digit code can be
 * extracted, or when the extracted code has no matching DC in {@link DC_LIST}.
 *
 * @param {unknown} text
 * @returns {DcEntry|null}
 */
export function resolveDcByName(text) {
  const code = extractDcCode(text);
  return code ? findDcByCode(code) : null;
}

/**
 * Resolve the depot (start/end point) for a store, preferring its `StoreName`
 * (more specific) and falling back to `DC_Name` when the store name does not
 * resolve. `null` when neither resolves to a known DC.
 *
 * @param {{ storeName?: unknown, dcName?: unknown }} [input]
 * @returns {DcEntry|null}
 */
export function resolveDepotForStore({ storeName, dcName } = {}) {
  return resolveDcByName(storeName) ?? resolveDcByName(dcName);
}
