/**
 * Excel parsing — pure over an in-memory buffer.
 *
 * `parseWorkbook(buffer)` reads ONLY the first worksheet of an uploaded `.xlsx`
 * file (Requirement 1.1) and returns the detected column headers, the mapped
 * data rows, and the row count (Requirement 1.2). Rows are keyed by the trimmed
 * header text of each column. When the buffer is not a readable `.xlsx`
 * workbook, an `IngestionError` is thrown so the upload route can respond with
 * a descriptive 400 (Requirement 1.3).
 *
 * ExcelJS loads a workbook directly from an in-memory Buffer
 * (`workbook.xlsx.load(buffer)`), so no temp files or disk cleanup are needed.
 */

import ExcelJS from "exceljs";
import { IngestionError } from "./errors.js";

// Re-export so callers can import the error type alongside the parser.
export { IngestionError };

/**
 * Parse the first worksheet of an .xlsx buffer.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} buffer  raw workbook bytes
 * @returns {Promise<{headers: string[], rows: object[], rowCount: number}>}
 * @throws {IngestionError} when the buffer cannot be read as an .xlsx workbook
 */
export async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer);
  } catch {
    // ExcelJS (via JSZip) rejects anything that is not a valid .xlsx archive.
    throw new IngestionError("File is not a readable .xlsx workbook");
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new IngestionError("File is not a readable .xlsx workbook");
  }

  // Header row (row 1): build the column-index -> trimmed-header mapping.
  const headerRow = worksheet.getRow(1);
  const columns = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    columns.push({ colNumber, key: cellText(cell.value).trim() });
  });
  const headers = columns.map((c) => c.key);

  // Data rows (row 2..N): one object per row keyed by trimmed header text.
  // Fully-empty trailing rows (which ExcelJS may retain) are skipped so the
  // reported rowCount reflects the actual data rows.
  const rows = [];
  const lastRow = worksheet.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = worksheet.getRow(r);
    const record = {};
    let hasValue = false;
    for (const { colNumber, key } of columns) {
      const value = normalizeValue(row.getCell(colNumber).value);
      record[key] = value;
      if (value !== null && value !== "") hasValue = true;
    }
    if (hasValue) rows.push(record);
  }

  return { headers, rows, rowCount: rows.length };
}

/**
 * Coerce a header cell value into plain text. Handles ExcelJS rich-text and
 * formula cells; plain strings/numbers pass through via String().
 * @param {*} value
 * @returns {string}
 */
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined && value.result !== null) {
      return String(value.result);
    }
  }
  return String(value);
}

/**
 * Normalize a data cell value. Dates pass through; rich-text/formula/hyperlink
 * cells are reduced to their text/result; empty cells become null.
 * @param {*} value
 * @returns {*}
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if (typeof value.text === "string") return value.text;
    if (value.result !== undefined) return value.result;
  }
  return value;
}
