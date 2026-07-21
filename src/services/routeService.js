/**
 * Route planning orchestration.
 *
 * Ties together the CVRP solver, ETA calculation and CO2 metrics into a
 * single "plan" that the API and dashboard consume. Also computes the
 * business success metrics from the workshop (distance/CO2 saved vs a
 * naive baseline).
 */

import { solveCVRP } from "../optimizer/vrp.js";
import { co2ForDistance } from "../optimizer/emissions.js";
import { etasFromLegs, defaultDepartAt } from "./etaService.js";
import { createRouter } from "../routing/router.js";

/**
 * Produce a full delivery plan.
 *
 * The CVRP solver decides the visit order using the fast built-in distance
 * estimate. Once each route is finalized, the routing layer computes the
 * *reported* distance and travel time per leg — from a real routing provider
 * (Longdo) when configured, otherwise the same estimator. Reported distance,
 * CO2 and per-stop ETAs are all derived from those leg metrics so they stay
 * consistent with whichever provider is active.
 *
 * @param {object} input
 * @param {{lat:number,lng:number}} input.depot  plan-level fallback depot
 * @param {Array<{depot?:{lat:number,lng:number}}>} input.vehicles  a vehicle
 *   MAY carry its own `depot` (e.g. a store's assigned DC) so its route starts
 *   and ends there instead of the plan-level depot; each returned route
 *   reports the resolved `depot` it actually used.
 * @param {Array} input.orders
 * @param {Date} [input.departAt]
 * @param {object} [input.router] - routing provider (defaults to createRouter()).
 * @returns {Promise<object>}
 */
export async function planDeliveries({
  depot,
  vehicles,
  orders,
  departAt = defaultDepartAt(),
  router = createRouter(),
}) {
  const { routes, unassignedOrders } = solveCVRP({ depot, vehicles, orders });

  const plannedRoutes = await Promise.all(
    routes.map(async (route) => {
      // Each route reports the depot it actually starts/ends at — the
      // vehicle's own depot (e.g. a store's assigned DC) when it has one,
      // otherwise the plan-level depot (solveCVRP already resolved this).
      const routeDepot = route.depot || depot;
      const legs = await legsForRoute(router, routeDepot, route.stops, route.vehicle);
      const distanceKm = sumDistanceKm(legs);
      const etas = etasFromLegs(route.stops, legs, departAt);
      const co2Kg = co2ForDistance(distanceKm, route.vehicle);

      return {
        vehicleId: route.vehicle.id,
        fuelType: route.vehicle.fuelType || "diesel",
        capacity: route.vehicle.capacity,
        load: route.load,
        utilization:
          route.vehicle.capacity === 0 ? 0 : round(route.load / route.vehicle.capacity),
        depot: routeDepot,
        distanceKm: round(distanceKm),
        co2Kg: round(co2Kg),
        stops: route.stops.map((stop, i) => ({
          orderId: stop.id,
          customer: stop.customer,
          address: stop.address,
          demand: stop.demand,
          location: stop.location,
          sequence: i + 1,
          eta: etas[i]?.etaISO ?? null,
          cumulativeKm: etas[i]?.cumulativeKm ?? null,
        })),
      };
    })
  );

  // Baseline: a single vehicle serves every order in arrival order, measured
  // with the same routing provider so the comparison is apples-to-apples.
  const baselineKm = sumDistanceKm(
    await legsForSequence(router, depot, orders.map((o) => o.location))
  );

  const metrics = buildMetrics({ orders, plannedRoutes, vehicles, baselineKm });

  return {
    generatedAt: new Date().toISOString(),
    departAt: departAt.toISOString(),
    routingProvider: router.provider,
    depot,
    routes: plannedRoutes,
    unassignedOrders: unassignedOrders.map((o) => ({
      orderId: o.id,
      customer: o.customer,
      demand: o.demand,
    })),
    metrics,
  };
}

/**
 * Leg metrics for a full route: depot -> stops... -> depot.
 * Returns [] for an empty route (no travel).
 */
function legsForRoute(router, depot, stops, vehicle) {
  if (stops.length === 0) return Promise.resolve([]);
  const locations = stops.map((s) => s.location);
  return legsForSequence(router, depot, locations, vehicle?.speedKmh);
}

/**
 * Leg metrics for depot -> locations... -> depot.
 */
function legsForSequence(router, depot, locations, speedKmh) {
  if (locations.length === 0) return Promise.resolve([]);
  const points = [depot, ...locations, depot];
  return router.routeLegs(points, { speedKmh });
}

function sumDistanceKm(legs) {
  return legs.reduce((sum, leg) => sum + leg.distanceKm, 0);
}

/**
 * Compute business success metrics: optimized vs naive baseline.
 * Baseline = one diesel vehicle serving all orders in arrival order.
 *
 * @param {{orders:Array, plannedRoutes:Array, vehicles:Array, baselineKm:number}} input
 */
function buildMetrics({ orders, plannedRoutes, vehicles, baselineKm }) {
  const optimizedKm = plannedRoutes.reduce((sum, r) => sum + r.distanceKm, 0);
  const optimizedCo2 = plannedRoutes.reduce((sum, r) => sum + r.co2Kg, 0);

  const baseKm = baselineKm;
  const baselineVehicle = { fuelType: "diesel" };
  const baseCo2 = co2ForDistance(baseKm, baselineVehicle);

  const distanceSavedKm = baseKm - optimizedKm;
  const co2SavedKg = baseCo2 - optimizedCo2;

  return {
    totalOrders: orders.length,
    ordersServed: plannedRoutes.reduce((n, r) => n + r.stops.length, 0),
    vehiclesUsed: plannedRoutes.filter((r) => r.stops.length > 0).length,
    fleetSize: vehicles.length,
    optimizedDistanceKm: round(optimizedKm),
    baselineDistanceKm: round(baseKm),
    distanceSavedKm: round(distanceSavedKm),
    distanceSavedPct: baseKm === 0 ? 0 : round((distanceSavedKm / baseKm) * 100),
    optimizedCo2Kg: round(optimizedCo2),
    baselineCo2Kg: round(baseCo2),
    co2SavedKg: round(co2SavedKg),
    co2SavedPct: baseCo2 === 0 ? 0 : round((co2SavedKg / baseCo2) * 100),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
