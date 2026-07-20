/**
 * History comparison router (Requirement 3, 4).
 *
 *   POST /api/history/compare   { filters }
 *
 * Delegates to `historyService.compareHistory({ filters })`, which reads the
 * joined History+Shop_Master rows, applies the pure filter, derives the
 * historical order from TIME_VISIT, optimizes the same customer set, and returns
 * either `{ customers, historicalDistanceKm, optimizedDistanceKm }` or a
 * `{ message }` guard (0 / 1 / no-match cases). Both shapes are returned as 200;
 * only unexpected failures (e.g. a DB error) reach the central handler as 500.
 *
 * The handler is async and forwards any rejected promise to `next(err)` so a
 * repository/DB rejection is surfaced through the central error handler rather
 * than crashing the process.
 *
 * SECURITY NOTE: this is an UNAUTHENTICATED planner endpoint — no auth on the
 * history comparison by design for this prototype. Add authentication before any
 * non-prototype deployment.
 */

import { Router } from "express";
import { compareHistory } from "../services/historyService.js";

const router = Router();

router.post("/compare", async (req, res, next) => {
  try {
    const { filters } = req.body || {};
    const result = await compareHistory({ filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
