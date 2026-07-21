/**
 * Database viewer router — read-only aggregate summary + paginated raw-row
 * browsing for the admin "Database" page.
 *
 *   GET /api/database/summary  -> { shops, history, presale, byDc, byStore }
 *   GET /api/database/shops    ?page=&pageSize=  -> { rows, total, page, pageSize }
 *   GET /api/database/history  ?page=&pageSize=  -> { rows, total, page, pageSize }
 *   GET /api/database/presale  ?page=&pageSize=  -> { rows, total, page, pageSize }
 *
 * `page`/`pageSize` are optional; invalid/absent values fall back to
 * sensible defaults in the repository layer (page 1, pageSize 50, capped at
 * 200) rather than erroring.
 *
 * This router is mounted behind `requireAdmin` in `routes/api.js`.
 */

import { Router } from "express";
import {
  getDatabaseSummary,
  listShops,
  listHistoryEntries,
  listPresaleEntries,
} from "../services/databaseViewService.js";

const router = Router();

/** Parse an optional positive-integer query param, or `undefined` when absent/invalid. */
function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function pagingFromQuery(q) {
  return { page: toPositiveInt(q.page), pageSize: toPositiveInt(q.pageSize) };
}

router.get("/summary", async (_req, res, next) => {
  try {
    res.json(await getDatabaseSummary());
  } catch (err) {
    next(err);
  }
});

router.get("/shops", async (req, res, next) => {
  try {
    res.json(await listShops(pagingFromQuery(req.query || {})));
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    res.json(await listHistoryEntries(pagingFromQuery(req.query || {})));
  } catch (err) {
    next(err);
  }
});

router.get("/presale", async (req, res, next) => {
  try {
    res.json(await listPresaleEntries(pagingFromQuery(req.query || {})));
  } catch (err) {
    next(err);
  }
});

export default router;
