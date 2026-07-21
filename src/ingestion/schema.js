/**
 * Workbook schema definitions, classification, and required-column validation.
 *
 * The ingestion pipeline reads three distinct Excel workbook types (History,
 * Shop_Master, Presale). Each type has a fixed set of REQUIRED columns (a
 * workbook missing any of them is rejected — Requirement 1.4) plus OPTIONAL
 * columns that are used when present but never cause a rejection.
 *
 * The required column names (including the Thai headers `จำนวนลง` /
 * `จำนวน Presale` and the space-containing `Store Area`) are matched against
 * the trimmed header text produced by `excelParser.parseWorkbook`.
 */

/**
 * Required + optional columns per workbook type (Requirement 1.4).
 * Keys are the canonical workbook-type identifiers used throughout ingestion.
 * @type {{ [type: string]: { required: string[], optional: string[] } }}
 */
export const WORKBOOK_SCHEMAS = {
  history: {
    // TIME_VISIT is intentionally NOT required: rows without a visit time are
    // still kept (the history comparison sorts them last) — the history mapper
    // records a non-excluding "soft" warning for them instead of dropping them.
    required: ["Customer_Code", "จำนวนลง"],
    optional: [
      "Customer_Name",
      "DC_Name",
      "StoreName",
      "InvoiceDate",
      "TIME_VISIT",
      "VISIT_TYPE",
      "StoreGroup",
      "Store Area",
      "CustomerType",
    ],
  },
  shopMaster: {
    required: [
      "Customer_code",
      "lat",
      "long",
      "service_time_min",
      "open_time",
      "close_time",
    ],
    optional: ["shop_name", "วันเข้าร้าน"],
  },
  presale: {
    required: ["CustomerName", "DELIVERY_DATE", "จำนวน Presale"],
    // Same optional categorical columns as history, when the presale workbook
    // carries them — lets the DC/store/group/area/type filters match presale
    // rows directly instead of relying on the (mostly absent) Shop_Master join.
    optional: ["DC_Name", "StoreName", "StoreGroup", "Store Area", "CustomerType"],
  },
};

/**
 * Build a lookup Set of trimmed header text from a headers array.
 * @param {string[]} headers
 * @returns {Set<string>}
 */
function headerSetOf(headers) {
  const set = new Set();
  for (const h of headers ?? []) {
    if (h === null || h === undefined) continue;
    set.add(String(h).trim());
  }
  return set;
}

/**
 * Score how well a schema matches a set of headers.
 * @param {{ required: string[], optional: string[] }} schema
 * @param {Set<string>} headerSet
 */
function scoreSchema(schema, headerSet) {
  const requiredPresent = schema.required.filter((c) => headerSet.has(c)).length;
  const optionalPresent = schema.optional.filter((c) => headerSet.has(c)).length;
  const allRequired =
    schema.required.length > 0 && requiredPresent === schema.required.length;
  return { allRequired, requiredPresent, optionalPresent };
}

/**
 * Decide whether candidate `a` is a better classification match than `b`.
 * Preference order: a full required-column match beats a partial one; then
 * more required columns matched; then more optional columns matched. Ties keep
 * the earlier candidate so classification is deterministic and stable in the
 * insertion order of WORKBOOK_SCHEMAS.
 */
function isBetterMatch(a, b) {
  if (a.allRequired !== b.allRequired) return a.allRequired;
  if (a.requiredPresent !== b.requiredPresent) {
    return a.requiredPresent > b.requiredPresent;
  }
  if (a.optionalPresent !== b.optionalPresent) {
    return a.optionalPresent > b.optionalPresent;
  }
  return false;
}

/**
 * Classify a workbook into "history" | "shopMaster" | "presale".
 *
 * When an explicit `hint` naming a known type is supplied (e.g. from the upload
 * form's `type` field) it is trusted and returned directly. Otherwise the type
 * is inferred from the headers by finding the schema whose required columns are
 * all present (best match); when no schema is a full match, the closest match
 * is returned so the caller can still run `validateColumns` and report exactly
 * which required columns are missing.
 *
 * @param {string[]} headers  detected column headers
 * @param {string}   [hint]   optional explicit workbook-type hint
 * @returns {"history"|"shopMaster"|"presale"}
 */
export function classifyWorkbook(headers, hint) {
  if (hint && Object.prototype.hasOwnProperty.call(WORKBOOK_SCHEMAS, hint)) {
    return hint;
  }

  const headerSet = headerSetOf(headers);
  const types = Object.keys(WORKBOOK_SCHEMAS);

  let bestType = types[0];
  let bestScore = scoreSchema(WORKBOOK_SCHEMAS[bestType], headerSet);

  for (let i = 1; i < types.length; i++) {
    const type = types[i];
    const score = scoreSchema(WORKBOOK_SCHEMAS[type], headerSet);
    if (isBetterMatch(score, bestScore)) {
      bestType = type;
      bestScore = score;
    }
  }

  return bestType;
}

/**
 * Validate that every required column for a workbook type is present.
 *
 * @param {"history"|"shopMaster"|"presale"} type
 * @param {string[]} headers  detected column headers
 * @returns {{ ok: boolean, missing: string[] }}
 *          `ok` is true only when no required columns are absent; `missing`
 *          lists each required column not found in `headers` (Requirement 1.4).
 * @throws {Error} when `type` is not a known workbook type
 */
export function validateColumns(type, headers) {
  const schema = WORKBOOK_SCHEMAS[type];
  if (!schema) {
    throw new Error(`Unknown workbook type: ${String(type)}`);
  }

  const headerSet = headerSetOf(headers);
  const missing = schema.required.filter((c) => !headerSet.has(c));

  return { ok: missing.length === 0, missing };
}
