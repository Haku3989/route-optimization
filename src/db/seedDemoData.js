/**
 * Demo/mockup data seed for showcasing the newer features (daily delivery
 * on-time report, driver live tracking, real-route maps) without depending
 * on the real dataset's geocoding coverage — most real customers in the dev
 * DB have no resolvable coordinates yet (see the geocoding fixes in
 * CHANGELOG.md), which makes those rows useless for a route/map demo.
 *
 * Reuses the same 15 curated, already-resolvable Bangkok-area stops from
 * `src/data/sampleData.js` (the ones already used by "Sample plan") as the
 * `shops` master data, then derives:
 *
 *   - `history_entries` for YESTERDAY (a completed day) — for the delivery
 *     on-time report. `time_visit` is NOT guessed: it's built from the
 *     store's REAL computed optimized ETA (via `solveCVRP` + `etasByCode`,
 *     the exact same pipeline `deliveryReportService` itself uses), offset
 *     by a deliberate early/on-time/late spread (±30/±2/±35 min — well
 *     outside the ±15 min classification boundary in both directions) so
 *     the report shows a realistic, correctly-classified mix regardless of
 *     which routing provider (Longdo vs. the built-in estimator) is
 *     configured when the report actually renders.
 *   - `presale_entries` for TODAY — for the presale planner and the driver
 *     map/live-tracking demo.
 *   - one driver account (`seedDrivers.js`'s existing upsert), assigned to
 *     the demo store so `GET /api/driver/route` resolves a real route once
 *     a presale plan has been built for today.
 *
 * Everything is written under one recognizable demo store name so it never
 * mixes into the real dataset and is trivial to isolate with the StoreName
 * filter on the dashboard/planner/report pages. Re-running this script is
 * idempotent: it deletes any previous demo history/presale rows for the
 * demo store before re-inserting, and `upsertShops`/`seedDrivers` are
 * already upserts.
 *
 * Run: node --env-file-if-exists=.env src/db/seedDemoData.js
 *
 * Optional environment overrides:
 *   SEED_DEMO_DRIVER_USERNAME   default: "demo_driver"
 *   SEED_DEMO_DRIVER_PASSWORD   default: a non-secret local-dev placeholder
 *     (a warning is logged when unset, same convention as seedDrivers.js)
 */

import { pathToFileURL } from "node:url";
import { query, initSchema, close } from "./pool.js";
import { upsertShops, insertHistoryEntries, insertPresaleEntries } from "./repositories.js";
import { seedDrivers } from "./seedDrivers.js";
import { solveCVRP } from "../optimizer/vrp.js";
import { etasByCode } from "../services/historyService.js";
import { defaultDepartAt, ETA_CONFIG } from "../services/etaService.js";
import { createRouter } from "../routing/router.js";
import { depot as sampleDepot, orders as sampleOrders } from "../data/sampleData.js";

export const DEMO_DC_NAME = "9999 Demo DC";
export const DEMO_STORE_NAME = "9999 Demo Showcase Store";
const DEMO_STORE_GROUP = "Demo";
const DEMO_STORE_AREA = "Bangkok Metro";
const DEMO_CUSTOMER_TYPE = "Modern Trade";
const DEMO_SERVICE_TIME_MIN = 8; // matches etaService's own default
const DEMO_OPEN_TIME = "04:00"; // vehicles depart at 04:00 by default — keep
const DEMO_CLOSE_TIME = "22:00"; // the window wide so demo ETAs never "violate" it

const DEMO_DRIVER_USERNAME = process.env.SEED_DEMO_DRIVER_USERNAME || "demo_driver";
const DEMO_DRIVER_PASSWORD = process.env.SEED_DEMO_DRIVER_PASSWORD || "demo-pass-only-change-me";

/** `"YYYY-MM-DD"` for a Date's LOCAL calendar day (mirrors etaService's own). */
function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * This app does not model real timezones end-to-end: a computed ETA's UTC
 * time-of-day directly represents the shop's LOCAL wall-clock time (see
 * etaService.js's `defaultDepartAt` doc), and `deliveryReportService`'s
 * `actualEtaFromVisit` anchors a bare "H:MM" `time_visit` the same way — by
 * embedding those digits directly as the UTC time-of-day. So a `time_visit`
 * derived from a computed ETA must read the ETA's UTC hours/minutes, NOT the
 * seeding machine's local ones (which would silently shift by that
 * machine's UTC offset).
 */
function utcHHMM(date) {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** category -> offset (minutes) applied to the real computed ETA. Margins are
 * generous around the ±15 min on-time tolerance so ordinary router variance
 * can never flip a stop into the wrong bucket. */
const CATEGORY_CYCLE = [
  { category: "early", offsetMin: -30 },
  { category: "on_time", offsetMin: 2 },
  { category: "late", offsetMin: 35 },
];

export function buildDemoShops() {
  return sampleOrders.map((o) => ({
    customerCode: o.id,
    shopName: o.customer,
    location: o.location,
    coordSource: "master",
    serviceTimeMin: DEMO_SERVICE_TIME_MIN,
    openTime: DEMO_OPEN_TIME,
    closeTime: DEMO_CLOSE_TIME,
  }));
}

/**
 * Compute each demo stop's real optimized ETA for `dayKey`, using the exact
 * same `solveCVRP` + `etasByCode` pipeline `deliveryReportService` uses, so
 * the synthetic `time_visit` values below are derived from a real computed
 * baseline instead of a guess.
 * @returns {Promise<Array<{customerCode:string, etaISO:string}>>}
 */
async function computeDemoEtas(dayKey) {
  const orders = sampleOrders.map((o) => ({
    id: o.id,
    demand: 1,
    location: o.location,
    serviceTimeMin: DEMO_SERVICE_TIME_MIN,
  }));
  const vehicle = { id: "DEMO-CALC", capacity: orders.length, speedKmh: ETA_CONFIG.DEFAULT_SPEED_KMH };
  const { routes } = solveCVRP({ depot: sampleDepot, vehicles: [vehicle], orders });
  const stops = routes.flatMap((r) => r.stops);

  const router = createRouter();
  const { etaByCode } = await etasByCode(
    router,
    sampleDepot,
    stops,
    defaultDepartAt(dayKey),
    ETA_CONFIG.DEFAULT_SPEED_KMH
  );
  return stops.map((s) => ({ customerCode: s.id, etaISO: etaByCode.get(s.id) }));
}

/** @returns {Promise<Array<object & {_category:string}>>} */
export async function buildDemoHistoryEntries(dayKey) {
  const etas = await computeDemoEtas(dayKey);
  return etas.map(({ customerCode, etaISO }, i) => {
    const order = sampleOrders.find((o) => o.id === customerCode);
    const { category, offsetMin } = CATEGORY_CYCLE[i % CATEGORY_CYCLE.length];
    const visitDate = new Date(new Date(etaISO).getTime() + offsetMin * 60000);
    return {
      customerCode,
      customerName: order?.customer ?? null,
      dcName: DEMO_DC_NAME,
      storeName: DEMO_STORE_NAME,
      invoiceDate: dayKey,
      timeVisit: utcHHMM(visitDate),
      visitType: "Delivery",
      storeGroup: DEMO_STORE_GROUP,
      storeArea: DEMO_STORE_AREA,
      customerType: DEMO_CUSTOMER_TYPE,
      quantity: order?.demand ?? 1,
      _category: category,
    };
  });
}

export function buildDemoPresaleEntries(dayKey) {
  return sampleOrders.map((o) => ({
    customerCode: o.id,
    customerName: o.customer,
    deliveryDate: dayKey,
    demand: o.demand,
    dcName: DEMO_DC_NAME,
    storeName: DEMO_STORE_NAME,
    storeGroup: DEMO_STORE_GROUP,
    storeArea: DEMO_STORE_AREA,
    customerType: DEMO_CUSTOMER_TYPE,
  }));
}

/** Delete any previously-seeded demo rows so re-running this script doesn't
 * accumulate duplicates (history/presale rows have no natural unique key to
 * upsert on). Scoped to the demo store name only — never touches real data. */
async function clearPreviousDemoRows() {
  await query(`DELETE FROM history_entries WHERE store_name = $1`, [DEMO_STORE_NAME]);
  await query(`DELETE FROM presale_entries WHERE store_name = $1`, [DEMO_STORE_NAME]);
}

export async function main() {
  if (!process.env.SEED_DEMO_DRIVER_PASSWORD) {
    console.warn(
      "[seed-demo] SEED_DEMO_DRIVER_PASSWORD is not set — using a non-secret " +
        "local-dev placeholder. Set it in any real environment."
    );
  }

  await initSchema();
  await clearPreviousDemoRows();

  const historyDayKey = localDayKey(addDays(new Date(), -1)); // yesterday: a completed day
  const presaleDayKey = localDayKey(new Date()); // today: the driver's active route

  const shopsWritten = await upsertShops(buildDemoShops());

  const historyRows = await buildDemoHistoryEntries(historyDayKey);
  const historyWritten = await insertHistoryEntries(historyRows);

  const presaleWritten = await insertPresaleEntries(buildDemoPresaleEntries(presaleDayKey));

  const driverCount = await seedDrivers([
    { username: DEMO_DRIVER_USERNAME, routeId: DEMO_STORE_NAME, password: DEMO_DRIVER_PASSWORD },
  ]);

  const categoryCounts = historyRows.reduce((acc, r) => {
    acc[r._category] = (acc[r._category] || 0) + 1;
    return acc;
  }, {});

  console.log(`[seed-demo] Store: "${DEMO_STORE_NAME}"  DC: "${DEMO_DC_NAME}"`);
  console.log(
    `[seed-demo] ${shopsWritten} shops, ${historyWritten} history rows (day ${historyDayKey}, ` +
      `mix ${JSON.stringify(categoryCounts)}), ${presaleWritten} presale rows (day ${presaleDayKey}).`
  );
  console.log(`[seed-demo] ${driverCount} driver upserted: ${DEMO_DRIVER_USERNAME} / ${DEMO_DRIVER_PASSWORD}`);
  console.log(
    "[seed-demo] Next: log in as admin, filter Delivery report to " +
      `StoreName="${DEMO_STORE_NAME}" / Day=${historyDayKey}; build a Presale plan filtered to the same ` +
      `store for ${presaleDayKey}, then log in as the demo driver to see it.`
  );

  await close();
}

// Run the seeding logic only when executed directly, not when imported.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error("[seed-demo] failed:", err && err.message ? err.message : err);
    try {
      await close();
    } catch {
      // Ignore secondary errors while shutting down after a failure.
    }
    process.exit(1);
  });
}
