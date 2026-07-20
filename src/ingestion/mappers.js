/**
 * Row mappers — turn parsed worksheet rows into internal records.
 *
 * Each mapper (`mapShopMasterRows`, `mapHistoryRows`, `mapPresaleRows`) takes
 * the row objects produced by `excelParser.parseWorkbook` (keyed by trimmed
 * header text) and returns `{ records, warnings }`:
 *
 *   - Rows that are blank in a REQUIRED column are EXCLUDED from `records` and a
 *     warning is recorded instead (Requirement 1.5); mapping then continues with
 *     the remaining rows (Requirement 1.6).
 *   - Warnings have the shape `{ row, reason, id? }`, where `row` is the 1-based
 *     worksheet row number (data rows start at row 2, because row 1 holds the
 *     headers) and `id` is the customer code when one is available.
 *   - The warning push is wrapped in try/catch so a failing warnings sink never
 *     stops the remaining rows from being mapped (Requirement 1.7). Callers may
 *     inject their own warnings collector (anything with a `.push` method).
 *
 * Records are shaped to the design Data Models (camelCase fields). Shop_Master
 * records carry the RAW `lat`/`long` in a `coordinates` field — coordinate
 * RESOLUTION (numeric/`(0,0)` handling, geocoding) happens later in the routing
 * layer, not here (Requirement 1.8).
 */

import { WORKBOOK_SCHEMAS } from "./schema.js";
import { parseCustomerCode } from "./customerCode.js";

/**
 * A required value is "blank" when it is null/undefined or a whitespace-only
 * string. Numeric values (including 0) are never blank.
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * Normalize a text-ish cell: trim strings, pass numbers/Dates through, and
 * turn null/undefined into null.
 * @param {*} value
 * @returns {*}
 */
function text(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim();
  return value;
}

/**
 * Coerce a numeric-ish cell to a Number when possible; fall back to null for
 * blanks and to the raw value when it is not numeric.
 * @param {*} value
 * @returns {number|null|*}
 */
function toNumber(value) {
  if (isBlank(value)) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : value;
}

/**
 * Push a warning without letting a throwing sink halt processing (Req 1.7).
 * @param {{ push: Function }} sink
 * @param {object} warning
 */
function safePush(sink, warning) {
  try {
    sink.push(warning);
  } catch {
    // Requirement 1.7: recording an exclusion warning must never stop the
    // remaining rows from being mapped. Swallow the sink failure and continue.
  }
}

/**
 * Shared row-mapping engine: exclude rows blank in a required column (recording
 * a warning), map the rest, and conserve the total (mapped + excluded == rows).
 *
 * @param {object[]} rows
 * @param {object}   opts
 * @param {string[]} opts.required   required column names for this workbook type
 * @param {(row:object)=>*} opts.getId  extracts the customer code (or null)
 * @param {(row:object)=>object} opts.toRecord  shapes a valid row into a record
 * @param {{ push: Function }} opts.warnings  collector (defaults to a fresh array)
 * @returns {{ records: object[], warnings: object[] }}
 */
function mapRows(rows, { required, getId, toRecord, warnings }) {
  const records = [];
  const list = Array.isArray(rows) ? rows : [];

  for (let i = 0; i < list.length; i++) {
    const row = list[i] ?? {};
    const rowNumber = i + 2; // 1-based worksheet row (row 1 = header row)

    const missing = required.filter((col) => isBlank(row[col]));
    if (missing.length > 0) {
      const warning = {
        row: rowNumber,
        reason: `Missing required value(s): ${missing.join(", ")}`,
      };
      const id = getId(row);
      if (id !== null && id !== undefined && id !== "") {
        warning.id = id;
      }
      safePush(warnings, warning);
      continue;
    }

    records.push(toRecord(row));
  }

  return { records, warnings };
}

/**
 * Map Shop_Master rows into ShopRecord objects (Requirement 1.8).
 *
 * Each record exposes a shop identifier (`customerCode`), a `coordinates` field
 * carrying the RAW `lat`/`long` (resolved later by the geocoder), the shop name,
 * the Session_Duration (`serviceTimeMin`), and the Working_Time
 * (`openTime`/`closeTime`).
 *
 * @param {object[]} rows
 * @param {{ push: Function }} [warnings]  optional injectable warnings collector
 * @returns {{ records: object[], warnings: object[] }}
 */
export function mapShopMasterRows(rows, warnings = []) {
  return mapRows(rows, {
    required: WORKBOOK_SCHEMAS.shopMaster.required,
    warnings,
    getId: (row) => text(row["Customer_code"]),
    toRecord: (row) => ({
      customerCode: String(row["Customer_code"]).trim(),
      shopName: text(row["shop_name"]),
      // Raw coordinates — resolution/(0,0) handling happens in the geocoder.
      coordinates: { lat: row["lat"], long: row["long"] },
      serviceTimeMin: toNumber(row["service_time_min"]), // Session_Duration
      openTime: text(row["open_time"]), // Working_Time start
      closeTime: text(row["close_time"]), // Working_Time end
    }),
  });
}

/**
 * Map History_Workbook rows into HistoryEntry objects.
 *
 * @param {object[]} rows
 * @param {{ push: Function }} [warnings]  optional injectable warnings collector
 * @returns {{ records: object[], warnings: object[] }}
 */
export function mapHistoryRows(rows, warnings = []) {
  return mapRows(rows, {
    required: WORKBOOK_SCHEMAS.history.required,
    warnings,
    getId: (row) => text(row["Customer_Code"]),
    toRecord: (row) => ({
      customerCode: String(row["Customer_Code"]).trim(),
      customerName: text(row["Customer_Name"]),
      dcName: text(row["DC_Name"]),
      storeName: text(row["StoreName"]),
      invoiceDate: row["InvoiceDate"] ?? null, // delivered date (raw)
      timeVisit: row["TIME_VISIT"] ?? null, // ordering key (raw)
      visitType: text(row["VISIT_TYPE"]),
      storeGroup: text(row["StoreGroup"]),
      storeArea: text(row["Store Area"]),
      customerType: text(row["CustomerType"]),
      quantity: toNumber(row["จำนวนลง"]),
    }),
  });
}

/**
 * Map Presale_Workbook rows into PresaleEntry objects (Requirement 5.1).
 *
 * The `Customer_Code` prefix is parsed out of `CustomerName`; `demand` comes
 * from `จำนวน Presale` and `deliveryDate` from `DELIVERY_DATE`.
 *
 * @param {object[]} rows
 * @param {{ push: Function }} [warnings]  optional injectable warnings collector
 * @returns {{ records: object[], warnings: object[] }}
 */
export function mapPresaleRows(rows, warnings = []) {
  return mapRows(rows, {
    required: WORKBOOK_SCHEMAS.presale.required,
    warnings,
    getId: (row) => parseCustomerCode(row["CustomerName"]).code,
    toRecord: (row) => {
      const { code, name } = parseCustomerCode(row["CustomerName"]);
      return {
        customerCode: code, // parsed prefix of CustomerName (may be null)
        customerName: name,
        deliveryDate: row["DELIVERY_DATE"] ?? null,
        demand: toNumber(row["จำนวน Presale"]),
      };
    },
  });
}
