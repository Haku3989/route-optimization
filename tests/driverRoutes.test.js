import test from "node:test";
import assert from "node:assert/strict";

import { getRouteForDriver } from "../src/routes/driverRoutes.js";

function fakePlan(routes) {
  return { plan: { routes } };
}

test("getRouteForDriver: returns ONLY the route matching the driver's own assigned store", async () => {
  const repositories = {
    findDriverById: async (id) => ({ id, username: "driver1", routeId: "Store A" }),
  };
  const latestPlan = () =>
    fakePlan([
      {
        vehicleId: "Store A",
        stops: [{ orderId: "C1", customer: "Shop 1", eta: "2026-01-01T08:00:00Z", location: { lat: 1, lng: 1 } }],
      },
      {
        vehicleId: "Store B",
        stops: [{ orderId: "C2", customer: "Shop 2", eta: "2026-01-01T09:00:00Z", location: { lat: 2, lng: 2 } }],
      },
    ]);

  const route = await getRouteForDriver(1, { repositories, getLatestPresalePlan: latestPlan });

  assert.equal(route.routeId, "Store A");
  assert.equal(route.stops.length, 1);
  assert.equal(route.stops[0].customerCode, "C1");
  assert.equal(route.currentSequence, 1);
});

test("getRouteForDriver: a driver never sees another driver's stops", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 2, username: "driver2", routeId: "Store B" }),
  };
  const latestPlan = () =>
    fakePlan([
      { vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }] },
      { vehicleId: "Store B", stops: [{ orderId: "C2", customer: "Shop 2" }] },
    ]);

  const route = await getRouteForDriver(2, { repositories, getLatestPresalePlan: latestPlan });

  assert.equal(route.stops.length, 1);
  assert.equal(route.stops[0].customerCode, "C2");
  for (const stop of route.stops) {
    assert.notEqual(stop.customerCode, "C1");
  }
});

test("getRouteForDriver: a driver with no store assignment gets an empty route, not everyone's stops", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 3, username: "driver3", routeId: null }),
  };
  const latestPlan = () =>
    fakePlan([{ vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }] }]);

  const route = await getRouteForDriver(3, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.stops, []);
  assert.equal(route.routeId, null);
  assert.equal(route.currentSequence, null);
});

test("getRouteForDriver: no matching vehicle for the driver's store -> empty route", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 4, username: "driver4", routeId: "Store Z" }),
  };
  const latestPlan = () =>
    fakePlan([{ vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }] }]);

  const route = await getRouteForDriver(4, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.stops, []);
});

test("getRouteForDriver: no presale plan built yet -> empty route", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 5, username: "driver5", routeId: "Store A" }),
  };
  const latestPlan = () => null;

  const route = await getRouteForDriver(5, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.stops, []);
  assert.equal(route.routeId, null);
});

test("getRouteForDriver: stops are re-sequenced from 1 for the driver's own route only", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 6, username: "driver6", routeId: "Store A" }),
  };
  const latestPlan = () =>
    fakePlan([
      {
        vehicleId: "Store A",
        stops: [
          { orderId: "C1", customer: "Shop 1" },
          { orderId: "C2", customer: "Shop 2" },
        ],
      },
    ]);

  const route = await getRouteForDriver(6, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.stops.map((s) => s.sequence), [1, 2]);
});
