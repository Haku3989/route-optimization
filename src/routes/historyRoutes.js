/**
 * History comparison router (Requirement 3, 4).
 *
 *   POST /api/history/compare   { filters }
 *   GET  /api/history/overview  -> { byDc, byStore }
 *   GET  /api/history/dates     -> { dates }  (same query params as /api/filters)
 *
 * Delegates to `historyService.compareHistory({ filters })`, which reads the
 * joined History+Shop_Master rows, applies the pure filter, derives the
 * historical order from TIME_VISIT, optimizes the same customer set, and returns
 * either `{ customers, historicalDistanceKm, optimizedDistanceKm }` or a
 * `{ message }` guard (0 / 1 / no-match cases). Both shapes are returned as 200;
 * only unexpected failures (e.g. a DB error) reach the central handler as 500.
 *
 * `GET /overview` powers the dashboard's fallback summary (breakdown by
 * DC_Name / StoreName) shown when no filter narrows `/compare` down to a
 * routable set.
 *
 * `GET /dates` powers the day-picker: routes are calculated per store PER
 * DAY, so the filter offers only days that actually have data for whatever
 * DC_Name/StoreName/etc. is currently selected — same cascading query-param
 * shape as `GET /api/filters`.
 *
 * The handlers are async and forward any rejected promise to `next(err)` so a
 * repository/DB rejection is surfaced through the central error handler rather
 * than crashing the process.
 *
 * This router is mounted behind `requireAdmin` in `routes/api.js`.
 */

import { Router } from "express";
import {
  compareHistory,
  getHistoryOverview,
  getHistoryDates,
} from "../services/historyService.js";

const router = Router();

/** Build the `{ dcName, storeName, ... }` active-filter bag from the same
 * query-string keys the filter forms use (mirrors `routes/api.js`'s `/filters`). */
function activeFiltersFromQuery(q) {
  return {
    dcName: typeof q.DC_Name === "string" ? q.DC_Name : undefined,
    storeName: typeof q.StoreName === "string" ? q.StoreName : undefined,
    storeGroup: typeof q.StoreGroup === "string" ? q.StoreGroup : undefined,
    storeArea: typeof q["Store Area"] === "string" ? q["Store Area"] : undefined,
    customerType: typeof q.CustomerType === "string" ? q.CustomerType : undefined,
  };
}

router.post("/compare", async (req, res, next) => {
  try {
    const { filters } = req.body || {};
    const result = await compareHistory({ filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/overview", async (_req, res, next) => {
  try {
    res.json(await getHistoryOverview());
  } catch (err) {
    next(err);
  }
});

router.get("/dates", async (req, res, next) => {
  try {
    const dates = await getHistoryDates(activeFiltersFromQuery(req.query || {}));
    res.json({ dates });
  } catch (err) {
    next(err);
  }
});

export default router;
