/**
 * REST API for the route optimization service.
 *
 *   GET  /api/scenario           -> depot, fleet and orders (ERP/WMS feed)
 *   POST /api/plan               -> optimized plan for a custom payload
 *   GET  /api/plan/sample        -> optimized plan for the sample scenario
 *   GET  /api/health             -> liveness probe
 *
 * Excel Route Planning feature routers (mounted below, alongside the routes
 * above without altering them):
 *   POST /api/ingest/upload      -> parse + persist an uploaded workbook
 *   POST /api/history/compare    -> historical vs optimized order comparison
 *   POST /api/presale/plan       -> optimized plan from the presale list
 *   POST /api/driver/login       -> driver authentication (bearer token)
 *   GET  /api/driver/route       -> the authenticated driver's assigned route
 */

import { Router } from "express";
import { planDeliveries } from "../services/routeService.js";
import { getScenario } from "../data/sampleData.js";
import ingestRoutes from "./ingestRoutes.js";
import historyRoutes from "./historyRoutes.js";
import presaleRoutes from "./presaleRoutes.js";
import driverRoutes from "./driverRoutes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

router.get("/scenario", (_req, res) => {
  res.json(getScenario());
});

router.get("/plan/sample", async (_req, res, next) => {
  try {
    const scenario = getScenario();
    const plan = await planDeliveries({
      depot: scenario.depot,
      vehicles: scenario.vehicles,
      orders: scenario.orders,
      departAt: new Date(),
    });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

router.post("/plan", async (req, res, next) => {
  try {
    const { depot, vehicles, orders, departAt } = req.body || {};

    const error = validatePayload({ depot, vehicles, orders });
    if (error) {
      return res.status(400).json({ error });
    }

    const plan = await planDeliveries({
      depot,
      vehicles,
      orders,
      departAt: departAt ? new Date(departAt) : new Date(),
    });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

function validatePayload({ depot, vehicles, orders }) {
  if (!depot || typeof depot.lat !== "number" || typeof depot.lng !== "number") {
    return "depot must include numeric lat and lng";
  }
  if (!Array.isArray(vehicles) || vehicles.length === 0) {
    return "vehicles must be a non-empty array";
  }
  for (const v of vehicles) {
    if (!v.id || typeof v.capacity !== "number" || v.capacity <= 0) {
      return `vehicle ${v?.id ?? "?"} must include an id and positive capacity`;
    }
  }
  if (!Array.isArray(orders) || orders.length === 0) {
    return "orders must be a non-empty array";
  }
  for (const o of orders) {
    if (!o.id || typeof o.demand !== "number" || !o.location) {
      return `order ${o?.id ?? "?"} must include id, demand and location`;
    }
    if (typeof o.location.lat !== "number" || typeof o.location.lng !== "number") {
      return `order ${o.id} location must include numeric lat and lng`;
    }
  }
  return null;
}

// Excel Route Planning feature sub-routers. This router is mounted at `/api`
// (see server.js), so these become /api/ingest/*, /api/history/*,
// /api/presale/*, and /api/driver/*.
router.use("/ingest", ingestRoutes);
router.use("/history", historyRoutes);
router.use("/presale", presaleRoutes);
router.use("/driver", driverRoutes);

export default router;
