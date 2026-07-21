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
import { distinctHistoryFilterValues } from "../db/repositories.js";
import ingestRoutes from "./ingestRoutes.js";
import historyRoutes from "./historyRoutes.js";
import presaleRoutes from "./presaleRoutes.js";
import driverRoutes from "./driverRoutes.js";
import adminRoutes from "./adminRoutes.js";
import { requireAdmin } from "./requireAdmin.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

router.get("/scenario", requireAdmin, (_req, res) => {
  res.json(getScenario());
});

/**
 * Distinct filter option lists sourced from the uploaded history data, keyed by
 * the workbook column names the filter forms use. Powers the categorical filter
 * dropdowns on the dashboard + planner. Admin-gated like the rest of the planner
 * surface.
 *
 * Accepts the same query-string keys as the filter forms (`DC_Name`,
 * `StoreName`, `StoreGroup`, `Store Area`, `CustomerType`) as the CURRENTLY
 * selected values; each returned column's options are then scoped by every
 * OTHER supplied value, so the dropdowns cascade with the data hierarchy
 * (e.g. `?DC_Name=...` narrows the returned `StoreName` list to that DC's
 * stores) instead of always listing every value in the dataset.
 */
router.get("/filters", requireAdmin, async (req, res, next) => {
  try {
    const q = req.query || {};
    const activeFilters = {
      dcName: typeof q.DC_Name === "string" ? q.DC_Name : undefined,
      storeName: typeof q.StoreName === "string" ? q.StoreName : undefined,
      storeGroup: typeof q.StoreGroup === "string" ? q.StoreGroup : undefined,
      storeArea: typeof q["Store Area"] === "string" ? q["Store Area"] : undefined,
      customerType: typeof q.CustomerType === "string" ? q.CustomerType : undefined,
    };
    const values = await distinctHistoryFilterValues(activeFilters);
    res.json({
      DC_Name: values.dcName,
      StoreName: values.storeName,
      StoreGroup: values.storeGroup,
      "Store Area": values.storeArea,
      CustomerType: values.customerType,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/plan/sample", requireAdmin, async (_req, res, next) => {
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

router.post("/plan", requireAdmin, async (req, res, next) => {
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
// /api/presale/*, /api/driver/*, and /api/admin/*.
//
// The ingest / history / presale routers are ADMIN-GATED (requireAdmin runs
// before each sub-router). The driver router keeps its own driver-session auth,
// and the admin router self-gates its user-management endpoints, so neither is
// wrapped here.
router.use("/ingest", requireAdmin, ingestRoutes);
router.use("/history", requireAdmin, historyRoutes);
router.use("/presale", requireAdmin, presaleRoutes);
router.use("/driver", driverRoutes);
router.use("/admin", adminRoutes);

export default router;
