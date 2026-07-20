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
    // Cache leg results so shared legs (e.g. baseline vs optimized) hit once.
    this._cache = new Map();
  }

  _cacheKey(from, to) {
    return `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  }

  /**
   * Query Longdo for a single leg's real distance and travel time.
   * @returns {Promise<LegMetric>}
   */
  async _leg(from, to) {
    const key = this._cacheKey(from, to);
    if (this._cache.has(key)) return this._cache.get(key);

    const url =
      `${this.baseUrl}?flon=${from.lng}&flat=${from.lat}` +
      `&tlon=${to.lng}&tlat=${to.lat}` +
      `&mode=${this.mode}&locale=en&key=${encodeURIComponent(this.apiKey)}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Longdo RouteService HTTP ${res.status}`);
    }

    const text = await res.text();
    // Longdo returns a JS error string (e.g. "throw '...Key Error';") on failure.
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

    const metric = {
      distanceKm: first.distance / 1000, // meters -> km
      durationMin:
        typeof first.interval === "number" ? first.interval / 60 : 0, // seconds -> min
    };
    this._cache.set(key, metric);
    return metric;
  }

  async routeLegs(points /*, opts */) {
    const legs = [];
    // Sequential to stay friendly with rate limits; cache avoids repeats.
    for (let i = 0; i < points.length - 1; i++) {
      legs.push(await this._leg(points[i], points[i + 1]));
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
