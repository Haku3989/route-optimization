/**
 * Backfill geocoding job.
 *
 * Persists a real `shops` row for every customer that appears in History but
 * has no Shop_Master row at all, and retries geocoding for existing shop rows
 * whose coordinates never resolved — so future History/Presale comparisons
 * find them via the normal Shop_Master join instead of needing a live
 * per-request geocode fallback (`historyService.js`'s geocoding fallback
 * stays in place as a safety net for anything this backfill still misses).
 *
 * ## Dedup by QUERY, not by customer
 *
 * Geocoding is deduplicated on the query string returned by
 * `findHistoryOnlyCustomers`/`findUnresolvedShops` (built by
 * `routing/geocodeQuery.js` from CustomerName + DC area context — see its
 * docs for why), and each unique query's result is applied to every customer
 * that shares it — without this, a repeated query would mean a redundant
 * network call for a result that would just come back identical. That query
 * is effectively unique per customer, so on a real dataset this dedup mostly
 * just protects against exact-name duplicates rather than collapsing tens of
 * thousands of rows into a few hundred queries the way a shared StoreName
 * query would — expect close to one real Longdo request per customer.
 *
 * `CONCURRENCY` unique queries are geocoded in parallel (a small worker
 * pool) to speed this up while staying gentle on the provider — but at
 * customer-name cardinality this can still mean many thousands of real
 * requests and a correspondingly long run / real risk of hitting the
 * provider's rate limits.
 *
 * ## Progress / status
 *
 * Runs as a fire-and-forget background job (triggered from `ingestRoutes.js`
 * once all three workbook types have been uploaded — see
 * `repositories.hasAllWorkbookTypes`). Progress is tracked in an in-memory
 * `status` object read by `getBackfillStatus()` (polled via
 * `GET /api/ingest/status`). Being in-memory, status resets on a process
 * restart — acceptable for this single-process prototype: a restart mid-job
 * simply means the next upload re-triggers it, and already-persisted shops
 * are skipped next time (they now have a Shop_Master row).
 *
 * Dependency injection: every exported function accepts an optional `deps`
 * bag (`{ repositories, geocoder }`) so tests can substitute in-memory fakes
 * and never touch a database or the network.
 */

import { createGeocoder } from "../routing/geocoder.js";
import * as realRepositories from "../db/repositories.js";

/** Unique geocode queries processed in parallel by the worker pool. */
const CONCURRENCY = 5;

/** Persist upserts in bounded chunks so memory/latency stay predictable for
 * a very large batch. */
const PERSIST_CHUNK_SIZE = 2000;

function initialStatus() {
  return {
    state: "idle", // "idle" | "running" | "done" | "error"
    queriesTotal: 0,
    queriesProcessed: 0,
    customersTotal: 0,
    customersResolved: 0,
    customersFailed: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

let status = initialStatus();

/** Current backfill progress (a snapshot copy — callers can't mutate job state). */
export function getBackfillStatus() {
  return { ...status };
}

/** True while a backfill run is in progress — guards against overlapping runs. */
export function isBackfillRunning() {
  return status.state === "running";
}

/**
 * Geocode every unique query with a small concurrent worker pool, updating
 * `statusRef.queriesProcessed` as each completes. A query the geocoder can't
 * resolve (or that throws) is cached as `null` so it isn't retried within
 * this run.
 *
 * @param {string[]} uniqueQueries
 * @param {{ geocode:(q:string)=>Promise<{lat:number,lng:number}|null> }} geocoder
 * @param {object} statusRef mutated in place to report progress
 * @returns {Promise<Map<string, {lat:number,lng:number}|null>>}
 */
async function geocodeUniqueQueries(uniqueQueries, geocoder, statusRef) {
  const cache = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueQueries.length) {
      const q = uniqueQueries[cursor++];
      const result = await geocoder.geocode(q).catch(() => null);
      cache.set(q, result ?? null);
      statusRef.queriesProcessed += 1;
    }
  }

  const workerCount = Math.min(CONCURRENCY, uniqueQueries.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return cache;
}

/**
 * Run the backfill job to completion, updating `status` throughout. Safe to
 * await directly in tests; the ingest route calls this WITHOUT awaiting
 * (fire-and-forget) so the upload response returns immediately.
 *
 * @param {{ repositories?: object, geocoder?: object }} [deps]
 * @returns {Promise<object>} the final status snapshot
 */
export async function runBackfill(deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const geocoder = deps.geocoder || createGeocoder();

  status = { ...initialStatus(), state: "running", startedAt: new Date().toISOString() };

  try {
    const [historyOnly, unresolvedShops] = await Promise.all([
      repositories.findHistoryOnlyCustomers(),
      repositories.findUnresolvedShops(),
    ]);

    const historyOnlyQueryable = historyOnly.filter((c) => c.geocodeQuery);
    const unresolvedShopsQueryable = unresolvedShops.filter((c) => c.geocodeQuery);

    const uniqueQueries = [
      ...new Set([
        ...historyOnlyQueryable.map((c) => c.geocodeQuery),
        ...unresolvedShopsQueryable.map((c) => c.geocodeQuery),
      ]),
    ];

    status.queriesTotal = uniqueQueries.length;
    status.customersTotal = historyOnly.length + unresolvedShopsQueryable.length;

    const resolved = await geocodeUniqueQueries(uniqueQueries, geocoder, status);

    // EVERY history-only customer gets a shops row this run — 'geocoded' when
    // resolved, 'unresolved' otherwise (including customers with no usable
    // query string at all). This is essential, not cosmetic: findHistoryOnlyCustomers()
    // only returns customers with NO shops row, so persisting an 'unresolved'
    // placeholder is what stops every future upload from re-scanning and
    // re-geocoding the same failed customers from scratch — a real dataset
    // can have tens of thousands of them. Existing 'unresolved' shop rows
    // (findUnresolvedShops) are the intended retry path for exactly these.
    const shopRecords = [];
    for (const c of historyOnly) {
      const location = c.geocodeQuery ? resolved.get(c.geocodeQuery) : null;
      shopRecords.push({
        customerCode: c.customerCode,
        // Resolved: the nicer customer name, for display. Unresolved: the
        // query that was actually attempted (`geocodeQuery`) — NOT
        // customerName, which is unique per customer and would defeat
        // findUnresolvedShops()'s dedup-by-shop_name on the next retry pass
        // (this bit us: a real run's unique-query count jumped from 685 to
        // ~37,000 once shopName stopped matching the shared query string).
        shopName: location ? (c.customerName ?? c.geocodeQuery) : c.geocodeQuery,
        location: location ?? null,
        coordSource: location ? "geocoded" : "unresolved",
      });
      if (location) status.customersResolved += 1;
      else status.customersFailed += 1;
    }
    // Existing unresolved shops only need a WRITE when this run actually
    // resolved them — leaving an unchanged 'unresolved' row alone avoids a
    // pointless UPDATE on every retry.
    for (const c of unresolvedShopsQueryable) {
      const location = resolved.get(c.geocodeQuery);
      if (location) {
        shopRecords.push({
          customerCode: c.customerCode,
          shopName: c.shopName,
          location,
          coordSource: "geocoded",
          serviceTimeMin: c.serviceTimeMin,
          openTime: c.openTime,
          closeTime: c.closeTime,
        });
        status.customersResolved += 1;
      } else {
        status.customersFailed += 1;
      }
    }

    for (let i = 0; i < shopRecords.length; i += PERSIST_CHUNK_SIZE) {
      await repositories.upsertShops(shopRecords.slice(i, i + PERSIST_CHUNK_SIZE));
    }

    status.state = "done";
    status.finishedAt = new Date().toISOString();
  } catch (err) {
    status.state = "error";
    status.error = err && err.message ? err.message : String(err);
    status.finishedAt = new Date().toISOString();
  }

  return getBackfillStatus();
}

/**
 * Trigger the backfill exactly once all three workbook types are present,
 * and only when a run isn't already in progress. Fire-and-forget: does NOT
 * await `runBackfill`, so the caller (the upload route) returns immediately;
 * any error is captured in `status` rather than rejecting.
 *
 * @param {{ repositories?: object, geocoder?: object }} [deps]
 * @returns {Promise<boolean>} true when a run was (just) started
 */
export async function triggerBackfillIfReady(deps = {}) {
  const repositories = deps.repositories || realRepositories;

  if (isBackfillRunning()) return false;
  if (!(await repositories.hasAllWorkbookTypes())) return false;

  runBackfill(deps).catch(() => {
    // runBackfill already records failures in `status`; nothing further to do.
  });
  return true;
}
