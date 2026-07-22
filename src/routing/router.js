/**
 * Pluggable routing layer.
 *
 * The optimizer (vrp.js) always uses the fast built-in distance estimate to
 * decide the visit order — that keeps optimization instant and free. Once a
 * plan is finalized, the router here computes the *reported* distance and
 * travel time for each leg. That is where a real routing provider (Longdo)
 * improves accuracy without slowing the optimizer down.
 *
 * Providers:
 *   - "estimator" (default): Haversine + road-detour factor, no network,
 *      no API key. Duration derived from an assumed vehicle speed.
 *   - "longdo": calls the Longdo Map RouteService for real road distance
 *      and travel time. Requires LONGDO_API_KEY.
 *
 * Select with the ROUTING_PROVIDER env var. If "longdo" is selected but no
 * key is present, we fall back to the estimator and log a warning.
 *
 * ## Route geometry (`opts.withGeometry`)
 *
 * `routeLegs()` normally returns just `{distanceKm, durationMin}` per leg —
 * no `geometry` key at all, so existing callers/shapes are untouched. Pass
 * `{ withGeometry: true }` to ALSO get `geometry: {lat,lng}[] | null` per
 * leg, for drawing a real road-following polyline on a map (as opposed to a
 * straight line between the two endpoints).
 *
 * Longdo's `route/guide` endpoint (used for distance/duration) does not
 * itself return usable geometry — its `route/path` and `geojson/route`
 * endpoints were tested live and consistently returned a geometry that never
 * reaches the leg's actual destination, an account/key-level limitation, not
 * a code bug. Geometry is instead fetched independently from OSRM's public
 * demo routing server (https://router.project-osrm.org — free, no key
 * required, but rate-limited and not intended for heavy production traffic).
 *
 * This decouples geometry entirely from the distance/duration provider:
 * `LongdoRouter` fetches OSRM geometry for a leg regardless of whether that
 * leg's Longdo distance/duration call succeeded, and a geometry failure
 * never affects distance/duration (or vice versa). Each has its own circuit
 * breaker (`_longdoDisabled` / `_osrmDisabled`) that trips independently —
 * once either service has failed once, later *distinct* legs skip its
 * network call entirely rather than paying a full failed-request cost per
 * leg. Either failure degrades only its own piece of data; the caller always
 * falls back gracefully (a straight line for missing geometry, the built-in
 * estimate for missing distance/duration).
 */

import { drivingDistanceKm } from "../optimizer/distance.js";

const DEFAULT_SPEED_KMH = 35;
const OSRM_DEFAULT_BASE_URL = "https://router.project-osrm.org/route/v1/driving";

/**
 * @typedef {{distanceKm:number, durationMin:number}} LegMetric
 */

class EstimatorRouter {
  constructor() {
    this.provider = "estimator";
  }

  /**
   * Metrics for each consecutive leg of a point sequence. No real geometry
   * is available offline — with `opts.withGeometry`, each leg still carries
   * `geometry: null` (not simply omitted) so callers can treat "estimator"
   * and "longdo-but-this-leg-failed" identically: always fall back to a
   * straight line between the two endpoints.
   * @param {Array<{lat:number,lng:number}>} points
   * @param {{speedKmh?:number, withGeometry?:boolean}} [opts]
   * @returns {Promise<LegMetric[]>}
   */
  async routeLegs(points, opts = {}) {
    const speed = opts.speedKmh || DEFAULT_SPEED_KMH;
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const distanceKm = drivingDistanceKm(points[i], points[i + 1]);
      const leg = { distanceKm, durationMin: (distanceKm / speed) * 60 };
      if (opts.withGeometry) leg.geometry = null;
      legs.push(leg);
    }
    return legs;
  }
}

class LongdoRouter {
  constructor(apiKey, opts = {}) {
    this.provider = "longdo";
    this.apiKey = apiKey;
    this.mode = opts.mode || process.env.LONGDO_ROUTE_MODE || "t"; // t = fastest w/ traffic
    this.baseUrl =
      opts.baseUrl ||
      process.env.LONGDO_BASE_URL ||
      "https://api.longdo.com/RouteService/json/route/guide";
    // Independent geometry source — see the module doc's "Route geometry"
    // section for why this is OSRM rather than Longdo's own endpoints.
    this.osrmBaseUrl = opts.osrmBaseUrl || process.env.OSRM_BASE_URL || OSRM_DEFAULT_BASE_URL;
    // How long a single leg's fetch may take before it's treated as a
    // failure. `fetch()` has no built-in timeout — an unresponsive (as
    // opposed to promptly-rejecting) Longdo endpoint would otherwise hang
    // each leg indefinitely; a route with N stops means N sequential legs,
    // so an unbounded per-leg hang compounds into a multi-minute request.
    this.requestTimeoutMs = opts.requestTimeoutMs || 8000;
    // Cache leg results (including fallback results) so shared legs (e.g.
    // baseline vs optimized, or the SAME leg retried after a failure) hit once.
    this._cache = new Map();
    // Degrade to this network-free estimator per-leg when Longdo fails (rate
    // limit, network error, bad response) instead of failing the whole plan.
    this._fallback = new EstimatorRouter();
    this._warnedFallback = false;
    // Circuit breaker: once Longdo has failed ONCE in this router's lifetime
    // (e.g. a persistent rate limit), every SUBSEQUENT *new* leg skips the
    // network call entirely rather than re-attempting (and re-failing) it.
    // Without this, a route with many stops pays a full failed-request cost
    // — potentially the whole `requestTimeoutMs` — for every distinct leg,
    // even though the first failure already told us Longdo isn't working for
    // this run. The exact-same-leg cache above doesn't help here since a
    // real route's legs are virtually all distinct pairs.
    this._longdoDisabled = false;
    // Mirrors `_longdoDisabled` but for the independent OSRM geometry
    // fetch — see the module doc's "Route geometry" section. Once one
    // geometry fetch fails, later *distinct* legs skip the OSRM network
    // call entirely rather than each paying a full failed-request cost.
    this._osrmDisabled = false;
    this._warnedOsrmFallback = false;
  }

  _cacheKey(from, to) {
    return `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  }

  /**
   * Query Longdo for a single leg's real distance and travel time. Throws on
   * any failure — HTTP error, the API's "throw '...';" error body, a
   * non-JSON body, a response missing distance data, or exceeding
   * `requestTimeoutMs` — so the caller (see `_leg`) can decide how to degrade.
   * @returns {Promise<LegMetric>}
   */
  async _fetchLeg(from, to) {
    const url =
      `${this.baseUrl}?flon=${from.lng}&flat=${from.lat}` +
      `&tlon=${to.lng}&tlat=${to.lat}` +
      `&mode=${this.mode}&locale=en&key=${encodeURIComponent(this.apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Longdo RouteService timed out after ${this.requestTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`Longdo RouteService HTTP ${res.status}`);
    }

    const text = await res.text();
    // Longdo returns a JS error string (e.g. "throw '...Too many requests...';")
    // on failure — including rate limiting — rather than a non-2xx status.
    if (text.trim().startsWith("throw")) {
      throw new Error(`Longdo RouteService error: ${text.trim()}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Longdo RouteService returned non-JSON response");
    }

    const first = Array.isArray(json.data) ? json.data[0] : null;
    if (!first || typeof first.distance !== "number") {
      throw new Error("Longdo RouteService response missing distance data");
    }

    return {
      distanceKm: first.distance / 1000, // meters -> km
      durationMin:
        typeof first.interval === "number" ? first.interval / 60 : 0, // seconds -> min
    };
  }

  /**
   * Resolve one leg's road-snapped geometry from OSRM's public routing
   * server — see the module doc's "Route geometry" section for why this is
   * independent of Longdo. Throws on any failure (HTTP error, timeout,
   * non-"Ok" response code, or missing geometry); the caller (`_leg`) treats
   * a geometry failure as non-fatal — it degrades only that leg's
   * `geometry` to `null`, never the distance/duration numbers.
   * @param {{lat:number,lng:number}} from
   * @param {{lat:number,lng:number}} to
   * @returns {Promise<Array<{lat:number,lng:number}>>}
   */
  async _fetchGeometry(from, to) {
    const url =
      `${this.osrmBaseUrl}/${from.lng},${from.lat};${to.lng},${to.lat}` +
      "?overview=full&geometries=geojson";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`OSRM route request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`OSRM route request HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.code !== "Ok") {
      throw new Error(`OSRM route request returned code ${json.code}`);
    }

    const coords = json.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) {
      throw new Error("OSRM route response missing geometry coordinates");
    }

    return coords
      .filter((c) => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number")
      .map(([lng, lat]) => ({ lat, lng }));
  }

  /**
   * Fetch this leg's OSRM geometry, applying the same failed-fast circuit
   * breaker pattern as Longdo's own (`_longdoDisabled`) but independently
   * (`_osrmDisabled`) — see the module doc's "Route geometry" section.
   * Never throws; a failure degrades to `null` (straight-line fallback).
   * @param {{lat:number,lng:number}} from
   * @param {{lat:number,lng:number}} to
   * @returns {Promise<Array<{lat:number,lng:number}>|null>}
   */
  async _legGeometry(from, to) {
    if (this._osrmDisabled) return null;
    try {
      return await this._fetchGeometry(from, to);
    } catch (err) {
      this._osrmDisabled = true;
      if (!this._warnedOsrmFallback) {
        console.warn(
          `[routing] OSRM geometry fetch failed (${err.message}); falling back ` +
            "to straight lines for this and any further legs."
        );
        this._warnedOsrmFallback = true;
      }
      return null;
    }
  }

  /**
   * Resolve a single leg, caching the result (whether from Longdo or the
   * fallback). On any Longdo distance/duration failure, degrades to the
   * network-free estimator for that leg AND trips the circuit breaker
   * (`_longdoDisabled`) so every later *new* leg on this router skips the
   * network call too — a rate limit, an outage, or a bad response never
   * fails the whole plan/comparison, and never pays a full failed-request
   * cost per leg either. Logs a warning ONCE per router instance so a run of
   * failing legs (e.g. a persistent rate limit) does not spam the log.
   *
   * `withGeometry` fetches a SECOND, independent piece of data (this leg's
   * OSRM road-snapped points) — attempted regardless of whether the
   * distance/duration call above succeeded or fell back, using its own
   * circuit breaker (`_osrmDisabled`, see `_legGeometry`).
   *
   * @param {{lat:number,lng:number}} from
   * @param {{lat:number,lng:number}} to
   * @param {number} [speedKmh]
   * @param {boolean} [withGeometry]
   * @returns {Promise<LegMetric>}
   */
  async _leg(from, to, speedKmh, withGeometry) {
    const key = this._cacheKey(from, to) + (withGeometry ? "|geo" : "");
    if (this._cache.has(key)) return this._cache.get(key);

    let metric;
    if (this._longdoDisabled) {
      const [fallback] = await this._fallback.routeLegs([from, to], { speedKmh });
      metric = fallback;
    } else {
      try {
        metric = await this._fetchLeg(from, to);
      } catch (err) {
        this._longdoDisabled = true;
        if (!this._warnedFallback) {
          console.warn(
            `[routing] Longdo RouteService failed (${err.message}); falling back ` +
              "to the built-in distance estimate for this and any further legs."
          );
          this._warnedFallback = true;
        }
        const [fallback] = await this._fallback.routeLegs([from, to], { speedKmh });
        metric = fallback;
      }
    }
    // Geometry is fetched from OSRM independently of Longdo's distance/
    // duration outcome above — see the module doc's "Route geometry" section.
    if (withGeometry) {
      metric.geometry = await this._legGeometry(from, to);
    }
    this._cache.set(key, metric);
    return metric;
  }

  /**
   * @param {Array<{lat:number,lng:number}>} points
   * @param {{speedKmh?:number, withGeometry?:boolean}} [opts]
   */
  async routeLegs(points, opts = {}) {
    const legs = [];
    // Sequential to stay friendly with rate limits; cache avoids repeats.
    for (let i = 0; i < points.length - 1; i++) {
      legs.push(await this._leg(points[i], points[i + 1], opts.speedKmh, opts.withGeometry));
    }
    return legs;
  }
}

/**
 * Create a router based on options / environment.
 * @param {{provider?:string, apiKey?:string, mode?:string, baseUrl?:string}} [options]
 */
export function createRouter(options = {}) {
  const provider = options.provider || process.env.ROUTING_PROVIDER || "estimator";

  if (provider === "longdo") {
    const apiKey = options.apiKey || process.env.LONGDO_API_KEY;
    if (!apiKey) {
      console.warn(
        "[routing] ROUTING_PROVIDER=longdo but LONGDO_API_KEY is not set — falling back to estimator."
      );
      return new EstimatorRouter();
    }
    return new LongdoRouter(apiKey, options);
  }

  return new EstimatorRouter();
}

export { EstimatorRouter, LongdoRouter, DEFAULT_SPEED_KMH };
