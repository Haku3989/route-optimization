/**
 * Presale plan router (Requirement 5, 6, 7).
 *
 *   POST /api/presale/plan   { filters?, depot?, vehicles?, departAt? }
 *
 * Delegates to `presaleService.buildPresalePlan(...)`, which joins Presale to
 * Shop_Master, filters, splits into routable orders vs unassigned customers,
 * optimizes + ETAs the routable orders, and flags working-time-window
 * violations. It returns either `{ plan, unassigned, windowViolations }` or a
 * `{ message }` guard when the filter matched no customers. Both shapes are
 * returned as 200; only unexpected failures reach the central handler as 500.
 *
 * The most recent successfully built plan is retained in-memory (see
 * `getLatestPresalePlan`) so the prototype driver route provider can surface a
 * route without a separate plan-persistence layer (see driverRoutes.js). This is
 * a deliberate prototype shortcut — durable plan/route assignment is out of
 * scope for this task.
 *
 * The handler is async and forwards any rejected promise to `next(err)`.
 *
 * SECURITY NOTE: this is an UNAUTHENTICATED planner endpoint — no auth on presale
 * planning by design for this prototype. Add authentication before any
 * non-prototype deployment.
 */

import { Router } from "express";
import { buildPresalePlan } from "../services/presaleService.js";

const router = Router();

/**
 * In-memory holder for the most recent presale plan result (the object returned
 * by buildPresalePlan when it produced a `plan`). `null` until the first plan is
 * built. Read by the driver route provider in driverRoutes.js.
 * @type {{ plan: object, unassigned: object[], windowViolations: object[] } | null}
 */
let latestPresalePlan = null;

/**
 * @returns {{ plan: object, unassigned: object[], windowViolations: object[] } | null}
 *   the most recent presale plan result, or `null` when none has been built.
 */
export function getLatestPresalePlan() {
  return latestPresalePlan;
}

router.post("/plan", async (req, res, next) => {
  try {
    const { filters, depot, vehicles, departAt } = req.body || {};
    const result = await buildPresalePlan({
      filters,
      depot,
      vehicles,
      departAt: departAt ? new Date(departAt) : undefined,
    });

    // Retain the latest plan so the prototype driver view has a route to show.
    if (result && result.plan) {
      latestPresalePlan = result;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
