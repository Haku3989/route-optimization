/**
 * Ingestion + persistence integration test (task 16.1).
 *
 * Builds an in-memory `.xlsx` fixture with ExcelJS and POSTs it to
 * `/api/ingest/upload` as a REAL `multipart/form-data` request (global
 * FormData/Blob + fetch) against the running Express app, then asserts the rows
 * were persisted in Postgres (via the repository joins / direct queries) and the
 * response `type` / `rowCount` / `mapped` / `warnings` are correct.
 *
 * Covers a Shop_Master upload plus Presale and History uploads. SKIPPED cleanly
 * when `DATABASE_URL` is unset; `truncateAll()` runs between tests for isolation.
 *
 * _Requirements: 1.1, 1.2, 1.4, 2.5_
 */

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import {
  DB_SKIP,
  loadPool,
  loadRepositories,
  loadApp,
  startServer,
  stopServer,
} from "./helpers/dbIntegration.js";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let pool;
let repositories;
let app;
let server;
let baseUrl;

before(async () => {
  if (DB_SKIP) return;
  pool = await loadPool();
  repositories = await loadRepositories();
  app = await loadApp();
  await pool.initSchema();
  ({ server, baseUrl } = await startServer(app));
});

beforeEach(async () => {
  if (DB_SKIP) return;
  await repositories.truncateAll();
});

after(async () => {
  if (DB_SKIP) return;
  await stopServer(server);
  await pool.close();
});

/**
 * Write a header row + data rows into a fresh in-memory .xlsx workbook and
 * return it as a Node Buffer (what a real upload would carry).
 */
async function buildWorkbook(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Sheet1");
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * POST a workbook buffer to /api/ingest/upload as multipart/form-data.
 * @returns {Promise<{ res: Response, json: any }>}
 */
async function uploadWorkbook(buffer, { type, filename = "book.xlsx" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: XLSX_MIME }), filename);
  if (type) form.append("type", type);
  const res = await fetch(`${baseUrl}/api/ingest/upload`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  return { res, json };
}

test(
  "POST /api/ingest/upload persists a Shop_Master workbook and reports counts + warnings",
  { skip: DB_SKIP },
  async () => {
    const headers = [
      "Customer_code",
      "shop_name",
      "lat",
      "long",
      "service_time_min",
      "open_time",
      "close_time",
    ];
    const rows = [
      ["S1", "Shop One", 13.72, 100.53, 10, "08:00", "17:00"], // resolvable (master)
      ["S2", "Shop Two", 0, 0, 5, "09:00", "16:00"], // (0,0) -> unresolved, warned by id
      ["S3", "Shop Three", "", "", 8, "08:30", "18:00"], // blank required lat/long -> excluded
    ];

    const { res, json } = await uploadWorkbook(await buildWorkbook(headers, rows), {
      type: "shopMaster",
    });

    assert.equal(res.status, 200);
    assert.equal(json.type, "shopMaster");
    assert.equal(json.rowCount, 3);
    assert.equal(json.mapped, 2); // S1 + S2 pass the mapper; S3 excluded (blank required)
    assert.deepEqual(json.headers, headers);

    // Warnings: S3 excluded by the mapper + S2 flagged for unresolved coordinates.
    const warnIds = json.warnings.map((w) => w.id).filter(Boolean);
    assert.ok(warnIds.includes("S2"), "expected an unresolved-coordinate warning for S2");
    assert.ok(warnIds.includes("S3"), "expected a missing-required-value warning for S3");

    // Persisted in Postgres: S1 resolved (master), S2 unresolved (null coords), S3 absent.
    const { rows: shopRows } = await pool.query(
      "SELECT customer_code, lat, lng, coord_source FROM shops ORDER BY customer_code"
    );
    assert.equal(shopRows.length, 2);
    const byCode = Object.fromEntries(shopRows.map((r) => [r.customer_code, r]));
    assert.equal(byCode.S1.coord_source, "master");
    assert.equal(Number(byCode.S1.lat), 13.72);
    assert.equal(Number(byCode.S1.lng), 100.53);
    assert.equal(byCode.S2.coord_source, "unresolved");
    assert.equal(byCode.S2.lat, null);
    assert.ok(!("S3" in byCode), "S3 should not be persisted (excluded by the mapper)");
  }
);

test(
  "POST /api/ingest/upload persists a Presale workbook (rows joinable in Postgres)",
  { skip: DB_SKIP },
  async () => {
    const headers = ["CustomerName", "DELIVERY_DATE", "จำนวน Presale"];
    const rows = [
      ["12345 ร้านสมชาย", "2026-02-01", 20],
      ["67890 ร้านสมหญิง", "2026-02-01", 8],
    ];

    const { res, json } = await uploadWorkbook(await buildWorkbook(headers, rows), {
      type: "presale",
    });

    assert.equal(res.status, 200);
    assert.equal(json.type, "presale");
    assert.equal(json.rowCount, 2);
    assert.equal(json.mapped, 2);

    const joined = await repositories.joinPresale();
    assert.equal(joined.length, 2);
    const byCode = Object.fromEntries(
      joined.map((j) => [j.presale.customerCode, j.presale])
    );
    assert.equal(byCode["12345"].demand, 20);
    assert.equal(byCode["67890"].demand, 8);
  }
);

test(
  "POST /api/ingest/upload persists a History workbook (rows joinable in Postgres)",
  { skip: DB_SKIP },
  async () => {
    const headers = ["Customer_Code", "TIME_VISIT", "จำนวนลง", "DC_Name"];
    const rows = [
      ["12345", "2026-01-10T09:15:00", 12, "DC Bangkok"],
      ["67890", "2026-01-10T10:30:00", 8, "DC Bangkok"],
    ];

    const { res, json } = await uploadWorkbook(await buildWorkbook(headers, rows), {
      type: "history",
    });

    assert.equal(res.status, 200);
    assert.equal(json.type, "history");
    assert.equal(json.rowCount, 2);
    assert.equal(json.mapped, 2);

    const joined = await repositories.joinHistory();
    assert.equal(joined.length, 2);
    const codes = joined.map((j) => j.history.customerCode).sort();
    assert.deepEqual(codes, ["12345", "67890"]);
  }
);
