/**
 * Excel ingestion router (Requirement 1, 2).
 *
 *   POST /api/ingest/upload   multipart/form-data { file: <.xlsx>, type?: hint }
 *
 * Flow (design "New API endpoints" + sequence "Uploads"):
 *   1. multer memoryStorage hands us the uploaded file as an in-memory Buffer
 *      (no temp files / disk cleanup). A file-size limit bounds memory use so a
 *      huge upload cannot exhaust the process.
 *   2. parseWorkbook(buffer)        -> { headers, rows, rowCount }  (Req 1.1, 1.2)
 *        - an unreadable / non-.xlsx buffer throws IngestionError -> 400.
 *   3. classifyWorkbook(headers, type hint) -> "history"|"shopMaster"|"presale".
 *   4. validateColumns(type, headers) -> reject with 400 naming each missing
 *      required column (Req 1.4).
 *   5. map rows with the type's mapper (Req 1.5-1.8); for Shop_Master, resolve
 *      each shop's coordinates through the geocoder (Req 2.1-2.4) and record an
 *      unresolved-coordinate warning by id.
 *   6. persist via the repository layer (upsert shops / insert history / insert
 *      presale) and respond 200 { type, rowCount, headers, mapped, warnings }.
 *
 * Error translation: an IngestionError (unreadable file, or — if ever thrown —
 * a client-safe validation failure) is translated to its own `.status` (400)
 * here; any other failure (a DB/pg rejection, an unexpected bug) is forwarded to
 * the central error handler in server.js via next(err) -> 500.
 *
 * SECURITY NOTE: this is an UNAUTHENTICATED planner endpoint — there is no auth
 * on ingest by design for this prototype. Uploaded cell values only ever reach
 * Postgres through the repository layer's parameterized queries, so untrusted
 * content is treated as data and cannot alter SQL; the multer size limit bounds
 * memory. Add authentication before any non-prototype deployment.
 */

import { Router } from "express";
import multer from "multer";

import { parseWorkbook } from "../ingestion/excelParser.js";
import { IngestionError } from "../ingestion/errors.js";
import { classifyWorkbook, validateColumns } from "../ingestion/schema.js";
import {
  mapShopMasterRows,
  mapHistoryRows,
  mapPresaleRows,
} from "../ingestion/mappers.js";
import { createGeocoder, resolveShopCoordinates } from "../routing/geocoder.js";
import * as repositories from "../db/repositories.js";

const router = Router();

/** Bound uploaded workbook size (5 MB) so a large file cannot exhaust memory. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * multer with in-memory storage, applied ONLY on this route. The existing
 * `express.json` body parser in server.js stays in place for every other route;
 * multer parses the `multipart/form-data` body just for the upload.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

router.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ error: "No file uploaded (expected a 'file' field)" });
    }

    // 1-2. Parse the first worksheet. Unreadable buffers throw IngestionError.
    const { headers, rows, rowCount } = await parseWorkbook(req.file.buffer);

    // 3. Classify using the optional form `type` hint, else infer from headers.
    const type = classifyWorkbook(headers, req.body && req.body.type);

    // 4. Reject when a required column is missing, naming each one (Req 1.4).
    const { ok, missing } = validateColumns(type, headers);
    if (!ok) {
      return res
        .status(400)
        .json({ error: `Missing required columns: ${missing.join(", ")}` });
    }

    // 5-6. Map + (for shops) resolve coordinates, then persist.
    let mapped = 0;
    let warnings = [];

    if (type === "shopMaster") {
      const result = mapShopMasterRows(rows);
      warnings = result.warnings;

      const geocoder = createGeocoder();
      const shopRecords = await Promise.all(
        result.records.map(async (record) => {
          const resolution = await resolveShopCoordinates(record, geocoder);
          if (!resolution.resolved) {
            // Req 2.3 / 2.4: exclude from routing (location stays null) AND record
            // the shop identifier in the warnings list — two mandatory steps.
            warnings.push({
              id: record.customerCode,
              reason: resolution.reason || "coordinates could not be resolved",
            });
          }
          return {
            customerCode: record.customerCode,
            shopName: record.shopName,
            location: resolution.location, // null when unresolved
            coordSource: resolution.source, // 'master' | 'longdo' | 'unresolved'
            serviceTimeMin: record.serviceTimeMin,
            openTime: record.openTime,
            closeTime: record.closeTime,
          };
        })
      );

      await repositories.upsertShops(shopRecords);
      mapped = shopRecords.length;
    } else if (type === "history") {
      const result = mapHistoryRows(rows);
      warnings = result.warnings;
      await repositories.insertHistoryEntries(result.records);
      mapped = result.records.length;
    } else {
      // presale
      const result = mapPresaleRows(rows);
      warnings = result.warnings;
      await repositories.insertPresaleEntries(result.records);
      mapped = result.records.length;
    }

    return res.json({ type, rowCount, headers, mapped, warnings });
  } catch (err) {
    // IngestionError carries a client-safe message + HTTP status (400). Any
    // other error (DB failure, unexpected bug) goes to the central handler.
    if (err instanceof IngestionError) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    return next(err);
  }
});

export default router;
