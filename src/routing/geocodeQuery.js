/**
 * Builds the geocode query string for a history row's own shop.
 *
 * `customerName` (e.g. "7-11 (สาขา แฟลตทหารเรือโพธิ์ทองจุด 2 - 1110)") is the
 * shop's real-world name, but its raw form rarely resolves with Longdo: live
 * testing against 685+ real customer names showed a 0% hit rate — the
 * trailing/leading numeric branch codes it carries ("- 1110", "2411-") are
 * noise Longdo's search doesn't match against. `cleanCustomerName` strips
 * those codes while keeping the Thai branch-location text they surround
 * (dropping the parentheses outright, rather than the whole group, avoids
 * collapsing e.g. "CJ Express (สาขา แฟลตทหารเรือโพธิ์ทองจุด 2 - 1110)" down to
 * the bare chain name "CJ Express" — tested and confirmed that DOES resolve,
 * but to some arbitrary CJ Express location, not the actual branch: a silent
 * wrong-coordinate bug, worse than staying unresolved). The cleaned name is
 * then combined with the delivery-center's area name (`dcName`, e.g. "1801
 * พัทยา" → "พัทยา") for extra disambiguating context between same-chain
 * branches.
 *
 * `storeName`/`dcName` remain the fallback tiers, used raw and unmodified —
 * they are DC/unit codes, not addresses, so cleaning them wouldn't help; they
 * exist purely so a row with no usable customerName still gets *some* query.
 *
 * @param {{ customerName?: string|null, dcName?: string|null, storeName?: string|null }} row
 * @returns {string|null}
 */
export function buildGeocodeQuery(row) {
  const cleanedName = cleanCustomerName(row?.customerName);
  if (cleanedName) {
    const area = dcArea(row?.dcName);
    return area ? `${cleanedName} ${area}` : cleanedName;
  }

  const storeName = typeof row?.storeName === "string" ? row.storeName.trim() : "";
  if (storeName) return storeName;

  const dcName = typeof row?.dcName === "string" ? row.dcName.trim() : "";
  if (dcName) return dcName;

  return null;
}

const THAI_CHAR = /[฀-๿]/;

/**
 * Strips numeric branch-code noise from a raw customer name while keeping
 * any Thai branch-location text: trailing "- NNN" before a closing paren,
 * leading "NNN-" after an opening paren, then unwraps remaining parenthetical
 * groups — keeping their text if Thai (real location info), dropping them
 * entirely if they're a bare alphanumeric code (e.g. "(MD92)").
 *
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function cleanCustomerName(name) {
  if (typeof name !== "string" || name.trim() === "") return null;

  let s = name;
  s = s.replace(/-\s*\d{3,}\s*\)/g, ")");
  s = s.replace(/\(\s*\d{3,}\s*-/g, "(");
  s = s.replace(/\(([^()]*)\)/g, (_match, inner) => (THAI_CHAR.test(inner) ? ` ${inner} ` : " "));
  s = s.replace(/\s+/g, " ").trim();

  return s === "" ? null : s;
}

/**
 * Strips a DC's leading numeric code, leaving its area name — e.g.
 * "1801 พัทยา" → "พัทยา".
 *
 * @param {string|null|undefined} dcName
 * @returns {string}
 */
export function dcArea(dcName) {
  if (typeof dcName !== "string") return "";
  return dcName.replace(/^\s*\d+\s*/, "").trim();
}
