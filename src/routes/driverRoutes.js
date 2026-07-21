/**
 * Driver auth + route router (Requirement 8.1, 9.1, 10.1, 10.2, 10.3).
 *
 *   POST /api/driver/login   { username, password } -> { token, driverId }
 *   GET  /api/driver/route   Authorization: Bearer <token> -> { route }
 *
 * Login delegates to `driverService.login`; any failure (unknown user, bad
 * password, malformed input) surfaces as the SAME generic AuthError, translated
 * here to `401 { error: "invalid username or password" }` so neither field is
 * revealed (Req 10.2). A DB/other error forwards to the central handler (500).
 *
 * The route endpoint reads the bearer token from the `Authorization` header and
 * calls `driverService.getDriverRoute(token, { getRouteForDriver })`. When the
 * token is invalid/absent the service throws AuthError BEFORE the route provider
 * is consulted, so the 401 response carries NO route or stop data (Req 10.3).
 *
 * ## Route provider: scoped to the driver's OWN store
 *
 * `getRouteForDriver(driverId)` builds a driver route from the MOST RECENT
 * presale plan (retained in-memory by presaleRoutes.js) — but ONLY the ONE
 * route whose `vehicleId` matches the driver's own assigned store
 * (`drivers.route_id`, set via the admin User Setup console). This mirrors
 * `resolveFleet()` in presaleService.js, which builds exactly one vehicle per
 * distinct driver-assigned store, so `vehicleId === routeId` reliably
 * identifies "this driver's own route". Previously this flattened EVERY
 * vehicle's stops into one list shown to EVERY driver — fixed here so a
 * driver only ever sees their own stops.
 *
 * A driver with no store assignment, or whose store has no route in the
 * latest plan (nothing to deliver, or no plan built yet), gets an empty
 * route `{ driverId, routeId: null, stops: [], currentSequence: null }` —
 * never another driver's stops.
 *
 * Durable plan/route persistence (vs. this in-memory "latest plan") is still
 * out of scope for this prototype.
 *
 * `buildMapsUrl` is imported from the canonical, full-featured implementation in
 * `public/driverView.js` (task 14) so there is a SINGLE source of truth shared
 * by the driver UI, this router, and the property tests. The relative path
 * `../../public/driverView.js` resolves from `src/routes/`; the module performs
 * no DOM access at import time, so it loads cleanly under Node here.
 */

import { Router } from "express";

import { login, getDriverRoute } from "../services/driverService.js";
import { AuthError } from "../auth/credentials.js";
import { getLatestPresalePlan } from "./presaleRoutes.js";
import { buildMapsUrl } from "../../public/driverView.js";
import * as realRepositories from "../db/repositories.js";

const router = Router();

/**
 * Route provider: the driver's OWN route from the most recent presale plan
 * (see module header), or an empty route when there is no match.
 *
 * @param {number} driverId  the authenticated driver's id
 * @param {{ repositories?: object, getLatestPresalePlan?: Function }} [deps]
 *   injectable for testing; default to the real repository module and the
 *   real in-memory latest-plan holder.
 * @returns {Promise<{ driverId:number, routeId:string|null,
 *   stops: Array<{ sequence:number, customerCode:string|null, customer:string|null,
 *     eta:string|null, location:object|null, address:string|null,
 *     completed:boolean, mapsUrl:string|null }>,
 *   currentSequence: number|null }>}
 */
export async function getRouteForDriver(driverId, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const readLatestPlan = deps.getLatestPresalePlan || getLatestPresalePlan;

  const driver = await repositories.findDriverById(driverId);
  const driverRouteId = driver?.routeId ?? null;

  const latest = readLatestPlan();
  const routes =
    latest && latest.plan && Array.isArray(latest.plan.routes)
      ? latest.plan.routes
      : [];

  const ownRoute = driverRouteId
    ? routes.find((route) => route.vehicleId === driverRouteId)
    : undefined;
  const sourceStops = ownRoute ? ownRoute.stops || [] : [];

  const stops = sourceStops.map((stop, i) => {
    const location = stop.location ?? null;
    const address = stop.address ?? null;
    return {
      sequence: i + 1,
      customerCode: stop.orderId ?? null,
      customer: stop.customer ?? null,
      eta: stop.eta ?? null,
      location,
      address,
      completed: false,
      mapsUrl: buildMapsUrl({ location, address }),
    };
  });

  return {
    driverId,
    routeId: stops.length > 0 ? driverRouteId : null,
    stops,
    currentSequence: stops.length > 0 ? 1 : null,
  };
}

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await login(username, password);
    res.json(result); // { token, driverId }
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ error: err.message });
    }
    next(err);
  }
});

router.get("/route", async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    const result = await getDriverRoute(token, { getRouteForDriver });
    res.json(result); // { route }
  } catch (err) {
    if (err instanceof AuthError) {
      // Req 10.3: withhold all route/stop information while unauthenticated.
      return res.status(err.status || 401).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * Extract the bearer token from the `Authorization: Bearer <token>` header, or
 * `null` when the header is absent/malformed (treated as unauthenticated).
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const header = (req.get && req.get("authorization")) || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

export { buildMapsUrl };
export default router;
