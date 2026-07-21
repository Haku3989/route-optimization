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
 */

import { drivingDistanceKm } from "../optimizer/distance.js";

const DEFAULT_SPEED_KMH = 35;

/**
 * @typedef {{distanceKm:number, durationMin:number}} LegMetric
 */

class EstimatorRouter {
  constructor() {
    this.provider = "estimator";
  }

  /**
   * Metrics for each consecutive leg of a point sequence.
   * @param {Array<{lat:number,lng:number}>} points
   * @param {{speedKmh?:number}} [opts]
   * @returns {Promise<LegMetric[]>}
   */
  async routeLegs(points, opts = {}) {
    const speed = opts.speedKmh || DEFAULT_SPEED_KMH;
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const distanceKm = drivingDistanceKm(points[i], points[i + 1]);
      legs.push({ distanceKm, durationMin: (distanceKm / speed) * 60 });
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
   * Resolve a single leg, caching the result (whether from Longdo or the
   * fallback). On any Longdo failure, degrades to the network-free estimator
   * for that leg AND trips the circuit breaker (`_longdoDisabled`) so every
   * later *new* leg on this router skips the network call too — a rate
   * limit, an outage, or a bad response never fails the whole plan/
   * comparison, and never pays a full failed-request cost per leg either.
   * Logs a warning ONCE per router instance so a run of failing legs (e.g. a
   * persistent rate limit) does not spam the log.
   * @returns {Promise<LegMetric>}
   */
  async _leg(from, to, speedKmh) {
    const key = this._cacheKey(from, to);
    if (this._cache.has(key)) return this._cache.get(key);

    let metric;
    if (this._longdoDisabled) {
      [metric] = await this._fallback.routeLegs([from, to], { speedKmh });
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
        [metric] = await this._fallback.routeLegs([from, to], { speedKmh });
      }
    }
    this._cache.set(key, metric);
    return metric;
  }

  async routeLegs(points, opts = {}) {
    const legs = [];
    // Sequential to stay friendly with rate limits; cache avoids repeats.
    for (let i = 0; i < points.length - 1; i++) {
      legs.push(await this._leg(points[i], points[i + 1], opts.speedKmh));
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
