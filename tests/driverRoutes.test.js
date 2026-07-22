import test from "node:test";
import assert from "node:assert/strict";

import { getRouteForDriver } from "../src/routes/driverRoutes.js";

function fakePlan(routes) {
  return { plan: { routes } };
}

/** Every fake repository needs this now that getRouteForDriver checks for
 * already-completed stops; default to "nothing completed yet". */
function noCompletions() {
  return async () => [];
}

test("getRouteForDriver: returns ONLY the route matching the driver's own assigned store", async () => {
  const repositories = {
    findDriverById: async (id) => ({ id, username: "driver1", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: noCompletions(),
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
    deliveryCompletionsForDriverDay: noCompletions(),
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
    deliveryCompletionsForDriverDay: noCompletions(),
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

test("getRouteForDriver: a persisted completion marks its stop completed and carries category/deviationMin, so a refresh doesn't lose it", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 7, username: "driver7", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: async (driverId, day) => {
      assert.equal(driverId, 7);
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      return [{ customerCode: "C1", category: "late", deviationMin: 20 }];
    },
  };
  const latestPlan = () =>
    fakePlan([
      {
        vehicleId: "Store A",
        stops: [
          { orderId: "C1", customer: "Shop 1", eta: "2026-01-01T08:00:00Z" },
          { orderId: "C2", customer: "Shop 2", eta: "2026-01-01T09:00:00Z" },
        ],
      },
    ]);

  const route = await getRouteForDriver(7, { repositories, getLatestPresalePlan: latestPlan });

  const c1 = route.stops.find((s) => s.customerCode === "C1");
  const c2 = route.stops.find((s) => s.customerCode === "C2");
  assert.equal(c1.completed, true);
  assert.equal(c1.category, "late");
  assert.equal(c1.deviationMin, 20);
  assert.equal(c2.completed, false);
  assert.equal(c2.category, null);
  // currentSequence should skip the completed stop and point at the next uncompleted one.
  assert.equal(route.currentSequence, c2.sequence);
});

test("getRouteForDriver: every stop completed -> currentSequence is null (route finished)", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 8, username: "driver8", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: async () => [
      { customerCode: "C1", category: "on_time", deviationMin: 2 },
    ],
  };
  const latestPlan = () =>
    fakePlan([{ vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1", eta: "2026-01-01T08:00:00Z" }] }]);

  const route = await getRouteForDriver(8, { repositories, getLatestPresalePlan: latestPlan });

  assert.equal(route.stops[0].completed, true);
  assert.equal(route.currentSequence, null);
});

test("getRouteForDriver: passes through the plan route's legsGeometry as routeGeometry, for the driver's own route only", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 9, username: "driver9", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: noCompletions(),
  };
  const ownGeometry = [[{ lat: 13.7, lng: 100.5 }, { lat: 13.71, lng: 100.51 }], null];
  const otherGeometry = [[{ lat: 99, lng: 99 }]];
  const latestPlan = () =>
    fakePlan([
      { vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }], legsGeometry: ownGeometry },
      { vehicleId: "Store B", stops: [{ orderId: "C2", customer: "Shop 2" }], legsGeometry: otherGeometry },
    ]);

  const route = await getRouteForDriver(9, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.routeGeometry, ownGeometry);
});

test("getRouteForDriver: an empty route (no stops) reports empty routeGeometry, not undefined/crash", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 10, username: "driver10", routeId: null }),
    deliveryCompletionsForDriverDay: noCompletions(),
  };
  const latestPlan = () => fakePlan([]);

  const route = await getRouteForDriver(10, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.routeGeometry, []);
});

test("getRouteForDriver: a plan route with no legsGeometry field (older/fake plan shape) degrades to empty routeGeometry, not a crash", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 11, username: "driver11", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: noCompletions(),
  };
  const latestPlan = () => fakePlan([{ vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }] }]);

  const route = await getRouteForDriver(11, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.routeGeometry, []);
});

test("getRouteForDriver: passes through the plan route's own depot, for the driver's own route only", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 12, username: "driver12", routeId: "Store A" }),
    deliveryCompletionsForDriverDay: noCompletions(),
  };
  const ownDepot = { lat: 13.75, lng: 100.5 };
  const otherDepot = { lat: 99, lng: 99 };
  const latestPlan = () =>
    fakePlan([
      { vehicleId: "Store A", stops: [{ orderId: "C1", customer: "Shop 1" }], depot: ownDepot },
      { vehicleId: "Store B", stops: [{ orderId: "C2", customer: "Shop 2" }], depot: otherDepot },
    ]);

  const route = await getRouteForDriver(12, { repositories, getLatestPresalePlan: latestPlan });

  assert.deepEqual(route.depot, ownDepot);
});

test("getRouteForDriver: an empty route (no stops) reports depot: null, not undefined/crash", async () => {
  const repositories = {
    findDriverById: async () => ({ id: 13, username: "driver13", routeId: null }),
    deliveryCompletionsForDriverDay: noCompletions(),
  };
  const latestPlan = () => fakePlan([]);

  const route = await getRouteForDriver(13, { repositories, getLatestPresalePlan: latestPlan });

  assert.equal(route.depot, null);
});
