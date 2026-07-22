/**
 * Daily delivery on-time report router.
 *
 *   POST /api/delivery-report/compute   { filters }
 *
 * Delegates to `deliveryReportService.computeDeliveryReport({ filters })`,
 * which requires the filter to resolve to a single day and returns either the
 * full `{ day, toleranceMin, stores, totals, rows, excluded, skippedStores }`
 * shape or a `{ message }` guard. Both shapes are returned as 200; only
 * unexpected failures (e.g. a DB error) reach the central handler as 500.
 *
 * This router is mounted behind `requireAdmin` in `routes/api.js`.
 */

import { Router } from "express";
import { computeDeliveryReport } from "../services/deliveryReportService.js";

const router = Router();

router.post("/compute", async (req, res, next) => {
  try {
    const { filters } = req.body || {};
    const result = await computeDeliveryReport({ filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
