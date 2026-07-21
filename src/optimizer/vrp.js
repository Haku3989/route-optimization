/**
 * Capacitated Vehicle Routing Problem (CVRP) solver.
 *
 * This is the "AI route optimization" core from the workshop. It is a
 * heuristic solver (not exact) chosen because VRP is NP-hard and we need
 * fast answers for real-time dispatch:
 *
 *   1. Greedy nearest-neighbour assignment of orders to vehicles,
 *      respecting each vehicle's load capacity.
 *   2. 2-opt local search to untangle each individual route.
 *
 * All routes start and end at the depot.
 */

import { drivingDistanceKm } from "./distance.js";

/**
 * Resolve the depot a route actually starts/ends at: the vehicle's own depot
 * when it has one (e.g. a store's assigned DC), otherwise the plan-level
 * depot. Additive — a `vehicle.depot` is entirely optional, so callers that
 * never set it see unchanged behavior.
 * @param {{lat:number,lng:number}} depot  plan-level fallback depot
 * @param {{depot?:{lat:number,lng:number}}} [vehicle]
 * @returns {{lat:number,lng:number}}
 */
export function depotForVehicle(depot, vehicle) {
  return (vehicle && vehicle.depot) || depot;
}

/**
 * Total driving distance (km) of a route: depot -> stops... -> depot.
 * @param {{lat:number,lng:number}} depot
 * @param {Array<{location:{lat:number,lng:number}}>} stops
 */
export function routeDistanceKm(depot, stops) {
  if (stops.length === 0) return 0;
  let total = drivingDistanceKm(depot, stops[0].location);
  for (let i = 0; i < stops.length - 1; i++) {
    total += drivingDistanceKm(stops[i].location, stops[i + 1].location);
  }
  total += drivingDistanceKm(stops[stops.length - 1].location, depot);
  return total;
}

/**
 * 2-opt improvement: repeatedly reverse route segments while that
 * shortens the total distance. Depot stays fixed at both ends.
 */
function twoOpt(depot, stops) {
  if (stops.length < 3) return stops;

  // Safety valve: 2-opt costs ~O(n^2) per improving pass, so a pathologically
  // large single route would hang the process. Above this size, skip refinement
  // and keep the nearest-neighbour order (callers that need many stops should
  // split them across vehicles). Normal routes are far below this bound.
  if (stops.length > 300) return stops.slice();

  let best = stops.slice();
  let improved = true;

  while (improved) {
    improved = false;
    const bestDist = routeDistanceKm(depot, best);

    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));

        if (routeDistanceKm(depot, candidate) + 1e-9 < bestDist) {
          best = candidate;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best;
}

/**
 * Greedy nearest-neighbour assignment respecting vehicle capacity. Each
 * vehicle's route starts from ITS OWN depot when `vehicle.depot` is set (e.g.
 * a store's assigned DC), otherwise the plan-level `depot`.
 */
function assignOrders(depot, vehicles, orders) {
  const unassigned = new Set(orders.map((o) => o.id));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const routes = [];

  // Larger vehicles first so we pack efficiently.
  const fleet = [...vehicles].sort((a, b) => b.capacity - a.capacity);

  for (const vehicle of fleet) {
    const stops = [];
    let load = 0;
    const vehicleDepot = depotForVehicle(depot, vehicle);
    let current = vehicleDepot;

    while (unassigned.size > 0) {
      let nearestId = null;
      let nearestDist = Infinity;

      for (const id of unassigned) {
        const order = orderById.get(id);
        if (load + order.demand > vehicle.capacity) continue;
        const d = drivingDistanceKm(current, order.location);
        if (d < nearestDist) {
          nearestDist = d;
          nearestId = id;
        }
      }

      if (nearestId === null) break; // nothing else fits this vehicle

      const order = orderById.get(nearestId);
      stops.push(order);
      load += order.demand;
      current = order.location;
      unassigned.delete(nearestId);
    }

    routes.push({ vehicle, stops, load, depot: vehicleDepot });
  }

  const unassignedOrders = [...unassigned].map((id) => orderById.get(id));
  return { routes, unassignedOrders };
}

/**
 * Solve the CVRP.
 *
 * @param {object} input
 * @param {{lat:number,lng:number}} input.depot  plan-level depot; used for any
 *   vehicle that does not set its own `depot`.
 * @param {Array<{id:string,capacity:number,fuelType?:string,speedKmh?:number,
 *   depot?:{lat:number,lng:number}}>} input.vehicles  a vehicle MAY carry its
 *   own `depot` (e.g. a store's assigned DC) so its route starts/ends there
 *   instead of the plan-level depot — used by presale planning, where each
 *   vehicle IS a store.
 * @param {Array<{id:string,demand:number,location:{lat:number,lng:number}}>} input.orders
 * @returns {{routes:Array<{vehicle:object, stops:Array, load:number,
 *   depot:{lat:number,lng:number}, distanceKm:number}>, unassignedOrders:Array}}
 *   each route additionally reports the RESOLVED `depot` it actually used.
 */
export function solveCVRP({ depot, vehicles, orders }) {
  if (!vehicles?.length) throw new Error("At least one vehicle is required");

  const { routes, unassignedOrders } = assignOrders(depot, vehicles, orders);

  const optimizedRoutes = routes.map(({ vehicle, stops, load, depot: vehicleDepot }) => {
    const optimizedStops = twoOpt(vehicleDepot, stops);
    return {
      vehicle,
      stops: optimizedStops,
      load,
      depot: vehicleDepot,
      distanceKm: routeDistanceKm(vehicleDepot, optimizedStops),
    };
  });

  return { routes: optimizedRoutes, unassignedOrders };
}

/**
 * Naive baseline: a single vehicle serves every order in arrival order.
 * Used to show how much the optimizer saves.
 */
export function baselineDistanceKm(depot, orders) {
  return routeDistanceKm(depot, orders);
}
