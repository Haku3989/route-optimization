import test from "node:test";
import assert from "node:assert/strict";

import { haversineKm, drivingDistanceKm } from "../src/optimizer/distance.js";
import { co2ForDistance, emissionFactorFor } from "../src/optimizer/emissions.js";
import { solveCVRP, routeDistanceKm, depotForVehicle } from "../src/optimizer/vrp.js";
import { computeETAs } from "../src/services/etaService.js";
import { planDeliveries } from "../src/services/routeService.js";

test("haversine: same point is zero", () => {
  const p = { lat: 13.75, lng: 100.5 };
  assert.equal(haversineKm(p, p), 0);
});

test("haversine: ~1 degree latitude is ~111 km", () => {
  const d = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(d > 110 && d < 112, `expected ~111, got ${d}`);
});

test("driving distance exceeds straight-line (detour factor)", () => {
  const a = { lat: 13.72, lng: 100.53 };
  const b = { lat: 13.78, lng: 100.54 };
  assert.ok(drivingDistanceKm(a, b) > haversineKm(a, b));
});

test("emission factors: EV is cleaner than diesel", () => {
  assert.ok(emissionFactorFor({ fuelType: "ev" }) < emissionFactorFor({ fuelType: "diesel" }));
  assert.equal(co2ForDistance(0, { fuelType: "diesel" }), 0);
});

test("CVRP respects vehicle capacity", () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 20, fuelType: "diesel" }];
  const orders = [
    { id: "A", demand: 15, location: { lat: 13.76, lng: 100.51 } },
    { id: "B", demand: 15, location: { lat: 13.77, lng: 100.52 } },
  ];
  const { routes, unassignedOrders } = solveCVRP({ depot, vehicles, orders });

  // Only one order fits (15 + 15 > 20), the other is unassigned.
  assert.equal(routes[0].load <= 20, true);
  assert.equal(routes[0].stops.length, 1);
  assert.equal(unassignedOrders.length, 1);
});

test("CVRP serves all orders when capacity is sufficient", () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.76, lng: 100.51 } },
    { id: "B", demand: 10, location: { lat: 13.77, lng: 100.52 } },
    { id: "C", demand: 10, location: { lat: 13.74, lng: 100.49 } },
  ];
  const { routes, unassignedOrders } = solveCVRP({ depot, vehicles, orders });
  assert.equal(unassignedOrders.length, 0);
  assert.equal(routes[0].stops.length, 3);
});

test("2-opt does not increase route distance vs input order", () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }];
  // Deliberately zig-zag order.
  const orders = [
    { id: "A", demand: 1, location: { lat: 13.80, lng: 100.50 } },
    { id: "B", demand: 1, location: { lat: 13.76, lng: 100.50 } },
    { id: "C", demand: 1, location: { lat: 13.78, lng: 100.50 } },
  ];
  const naive = routeDistanceKm(depot, orders);
  const { routes } = solveCVRP({ depot, vehicles, orders });
  assert.ok(routes[0].distanceKm <= naive + 1e-6);
});

// ---------------------------------------------------------------------------
// Per-vehicle depot (a store's own DC as start/end point)
// ---------------------------------------------------------------------------

test("depotForVehicle: uses the vehicle's own depot when set, else the plan-level depot", () => {
  const planDepot = { lat: 13.75, lng: 100.5 };
  const vehicleDepot = { lat: 13.93, lng: 100.43 };
  assert.deepEqual(depotForVehicle(planDepot, { depot: vehicleDepot }), vehicleDepot);
  assert.deepEqual(depotForVehicle(planDepot, { depot: undefined }), planDepot);
  assert.deepEqual(depotForVehicle(planDepot, {}), planDepot);
  assert.deepEqual(depotForVehicle(planDepot, undefined), planDepot);
});

test("solveCVRP: a vehicle with its own depot starts/ends its route there, not at the plan depot", () => {
  const planDepot = { lat: 13.75, lng: 100.5 };
  const storeDepot = { lat: 14.0, lng: 100.9 }; // far from planDepot and the stops
  const vehicles = [
    { id: "STORE-A", capacity: 100, fuelType: "diesel", depot: storeDepot },
  ];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.76, lng: 100.51 } },
    { id: "B", demand: 10, location: { lat: 13.77, lng: 100.52 } },
  ];

  const { routes } = solveCVRP({ depot: planDepot, vehicles, orders });
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].depot, storeDepot);

  // The reported route distance must match a route computed against the
  // vehicle's own depot, NOT the plan-level depot.
  const expected = routeDistanceKm(storeDepot, routes[0].stops);
  assert.equal(routes[0].distanceKm, expected);
  assert.notEqual(routes[0].distanceKm, routeDistanceKm(planDepot, routes[0].stops));
});

test("solveCVRP: a vehicle with no depot falls back to the plan-level depot (unchanged behavior)", () => {
  const planDepot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }]; // no `depot`
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.76, lng: 100.51 } },
    { id: "B", demand: 10, location: { lat: 13.77, lng: 100.52 } },
  ];

  const { routes } = solveCVRP({ depot: planDepot, vehicles, orders });
  assert.deepEqual(routes[0].depot, planDepot);
  assert.equal(routes[0].distanceKm, routeDistanceKm(planDepot, routes[0].stops));
});

test("ETAs are strictly increasing in time", () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicle = { id: "V1", speedKmh: 40 };
  const stops = [
    { id: "A", location: { lat: 13.76, lng: 100.51 } },
    { id: "B", location: { lat: 13.80, lng: 100.55 } },
  ];
  const start = new Date("2026-01-01T08:00:00Z");
  const etas = computeETAs(depot, vehicle, stops, start);
  assert.equal(etas.length, 2);
  assert.ok(new Date(etas[1].etaISO) > new Date(etas[0].etaISO));
  assert.ok(etas[1].cumulativeKm > etas[0].cumulativeKm);
});

test("planDeliveries reports non-negative savings vs baseline", async () => {
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [
    { id: "V1", capacity: 50, fuelType: "diesel" },
    { id: "V2", capacity: 50, fuelType: "ev" },
  ];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.72, lng: 100.53 } },
    { id: "B", demand: 10, location: { lat: 13.80, lng: 100.55 } },
    { id: "C", demand: 10, location: { lat: 13.66, lng: 100.60 } },
    { id: "D", demand: 10, location: { lat: 13.88, lng: 100.55 } },
  ];
  const plan = await planDeliveries({ depot, vehicles, orders });
  assert.equal(plan.metrics.ordersServed, 4);
  assert.ok(plan.metrics.co2SavedKg >= 0);
  assert.ok(plan.metrics.optimizedDistanceKm > 0);
  // Default provider is the built-in estimator.
  assert.equal(plan.routingProvider, "estimator");
});

test("planDeliveries: default estimator matches direct route distance", async () => {
  // With the estimator provider, reported route distance must equal the
  // solver's own depot->stops->depot distance (no drift from the abstraction).
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.72, lng: 100.53 } },
    { id: "B", demand: 10, location: { lat: 13.80, lng: 100.55 } },
    { id: "C", demand: 10, location: { lat: 13.66, lng: 100.60 } },
  ];
  const plan = await planDeliveries({ depot, vehicles, orders });
  const { routes } = solveCVRP({ depot, vehicles, orders });
  const expected = round2(routeDistanceKm(depot, routes[0].stops));
  assert.equal(plan.routes[0].distanceKm, expected);
});

test("planDeliveries: ETAs and distance come from the injected router", async () => {
  // A fake router returns fixed 2 km / 6 min per leg, letting us assert the
  // pipeline actually consumes router output instead of the estimator.
  const fakeRouter = {
    provider: "fake",
    async routeLegs(points) {
      return points.slice(1).map(() => ({ distanceKm: 2, durationMin: 6 }));
    },
  };
  const depot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.72, lng: 100.53 } },
    { id: "B", demand: 10, location: { lat: 13.80, lng: 100.55 } },
  ];
  const departAt = new Date("2026-01-01T08:00:00Z");
  const plan = await planDeliveries({ depot, vehicles, orders, departAt, router: fakeRouter });

  assert.equal(plan.routingProvider, "fake");
  // 2 stops + return leg = 3 legs * 2 km.
  assert.equal(plan.routes[0].distanceKm, 6);
  // First stop: 6 min travel from depot -> 08:06.
  assert.equal(plan.routes[0].stops[0].eta, "2026-01-01T08:06:00.000Z");
  // Second stop: 6 min + 8 min service + 6 min travel -> 08:20.
  assert.equal(plan.routes[0].stops[1].eta, "2026-01-01T08:20:00.000Z");
});

test("planDeliveries: a route reports the vehicle's own depot when set (additive field)", async () => {
  const planDepot = { lat: 13.75, lng: 100.5 };
  const storeDepot = { lat: 14.0, lng: 100.9 };
  const vehicles = [{ id: "STORE-A", capacity: 100, fuelType: "diesel", depot: storeDepot }];
  const orders = [
    { id: "A", demand: 10, location: { lat: 13.76, lng: 100.51 } },
    { id: "B", demand: 10, location: { lat: 13.77, lng: 100.52 } },
  ];

  const plan = await planDeliveries({ depot: planDepot, vehicles, orders });
  assert.equal(plan.routes.length, 1);
  assert.deepEqual(plan.routes[0].depot, storeDepot);
});

test("planDeliveries: a route with no vehicle depot reports the plan-level depot", async () => {
  const planDepot = { lat: 13.75, lng: 100.5 };
  const vehicles = [{ id: "V1", capacity: 100, fuelType: "diesel" }];
  const orders = [{ id: "A", demand: 10, location: { lat: 13.76, lng: 100.51 } }];

  const plan = await planDeliveries({ depot: planDepot, vehicles, orders });
  assert.deepEqual(plan.routes[0].depot, planDepot);
});

function round2(n) {
  return Math.round(n * 100) / 100;
}
