/**
 * Coordinate resolution — companion geocoder for the routing layer.
 *
 * This mirrors the estimator/Longdo provider pattern in `router.js` and reuses
 * the same `LONGDO_API_KEY`. It exists so shops that lack usable coordinates in
 * the Shop_Master can (optionally) be geocoded before routing, while shops that
 * still cannot be resolved are FLAGGED rather than guessed.
 *
 * Providers:
 *   - "estimator" (default): `geocode()` always returns null. No network, no key
 *     — every shop without usable master coordinates is left unresolved so the
 *     ingestion layer can exclude it and warn, instead of inventing a location.
 *   - "longdo": queries the Longdo address-search / geocoding endpoint
 *     (https://search.longdo.com/mapsearch/json/search) authenticated with the
 *     same `key` query parameter used by the routing layer. Network / HTTP /
 *     parse errors are treated as "unresolved" (return null) and never crash a
 *     plan (design Error Handling: 2.2, 2.3).
 *
 * Select the provider with the ROUTING_PROVIDER env var or an explicit
 * `{ provider }` option. If "longdo" is selected but no key is present we fall
 * back to the estimator and log a warning (same behaviour as `createRouter`).
 *
 * Env vars read here:
 *   - ROUTING_PROVIDER  ("estimator" | "longdo"), default "estimator"
 *   - LONGDO_API_KEY    reused from the routing layer (no key -> estimator)
 *   - LONGDO_GEOCODE_URL optional override of the search endpoint base URL
 */

const DEFAULT_GEOCODE_URL = "https://search.longdo.com/mapsearch/json/search";

/**
 * @typedef {{ lat:number, lng:number }} LatLng
 */

/**
 * Coerce a coordinate cell to a finite Number, or null when it is blank or
 * non-numeric. Whitespace-only strings and empty strings are treated as blank
 * (null) rather than the Number("") === 0 trap.
 * @param {*} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A coordinate pair is usable when both components are finite numbers and the
 * pair is not the suspicious (0,0) point (Requirement 2.4).
 * @param {number|null} lat
 * @param {number|null} lng
 * @returns {boolean}
 */
function isUsablePair(lat, lng) {
  if (lat === null || lng === null) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * Read the RAW coordinates off a shop record. The ShopRecord produced by
 * `mappers.js` carries them as `shop.coordinates = { lat, long }` (note `long`,
 * not `lng`). We also tolerate a `lng` field and top-level coordinates.
 * @param {object} shop
 * @returns {{ lat:number|null, lng:number|null }}
 */
function readRawCoords(shop) {
  if (!shop || typeof shop !== "object") return { lat: null, lng: null };
  const c =
    shop.coordinates && typeof shop.coordinates === "object"
      ? shop.coordinates
      : shop;
  const lat = toFiniteNumber(c.lat);
  const lng = toFiniteNumber(c.lng !== undefined ? c.lng : c.long);
  return { lat, lng };
}

/**
 * Build the address/name string to hand to the geocoder. Prefers an explicit
 * address, then the shop name, then the customer name.
 * @param {object} shop
 * @returns {string|null}
 */
function geocodeQuery(shop) {
  if (!shop || typeof shop !== "object") return null;
  const candidates = [shop.address, shop.shopName, shop.customerName, shop.customer];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Parse a Longdo search/geocoding JSON response into { lat, lng } or null.
 *
 * ASSUMPTION (documented): the Longdo map-search endpoint returns an object
 * with a `data` array of results, each carrying a latitude field `lat` and a
 * longitude field `lon`. Because the exact shape is external and can vary, this
 * parser is defensive: it also accepts a bare top-level array, and accepts
 * `lon` / `lng` / `long` as the longitude field name. Anything that does not
 * yield two finite numbers is treated as "no result" (null).
 * @param {*} json
 * @returns {LatLng|null}
 */
function parseLongdoSearchResponse(json) {
  if (!json || typeof json !== "object") return null;
  const list = Array.isArray(json)
    ? json
    : Array.isArray(json.data)
      ? json.data
      : [];
  if (list.length === 0) return null;

  const first = list[0];
  if (!first || typeof first !== "object") return null;

  const lat = toFiniteNumber(first.lat);
  const lngRaw =
    first.lon !== undefined
      ? first.lon
      : first.lng !== undefined
        ? first.lng
        : first.long;
  const lng = toFiniteNumber(lngRaw);

  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * Estimator geocoder: never resolves. Keeps the app network-free and key-free;
 * unresolved shops are flagged by the caller instead of being guessed.
 */
class EstimatorGeocoder {
  constructor() {
    this.provider = "estimator";
  }

  /**
   * @returns {Promise<null>}
   */
  async geocode() {
    return null;
  }
}

/**
 * Longdo geocoder: queries the Longdo map-search endpoint. All failures
 * (network throw, non-2xx HTTP, non-JSON body, no usable result) resolve to
 * null so the caller treats the shop as unresolved rather than crashing.
 */
class LongdoGeocoder {
  constructor(apiKey, opts = {}) {
    this.provider = "longdo";
    this.apiKey = apiKey;
    this.baseUrl =
      opts.baseUrl || process.env.LONGDO_GEOCODE_URL || DEFAULT_GEOCODE_URL;
  }

  /**
   * @param {string} address
   * @returns {Promise<LatLng|null>}
   */
  async geocode(address) {
    const query = typeof address === "string" ? address.trim() : "";
    if (query === "") return null;

    const url =
      `${this.baseUrl}?keyword=${encodeURIComponent(query)}` +
      `&limit=1&locale=en&key=${encodeURIComponent(this.apiKey)}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null; // HTTP error -> unresolved (Req 2.2, 2.3)
      const json = await res.json();
      return parseLongdoSearchResponse(json);
    } catch {
      // Network failure / non-JSON body -> unresolved, never throw (Req 2.3).
      return null;
    }
  }
}

/**
 * Create a geocoder based on options / environment, mirroring `createRouter`.
 * @param {{ provider?:string, apiKey?:string, baseUrl?:string }} [options]
 * @returns {EstimatorGeocoder|LongdoGeocoder}
 */
export function createGeocoder(options = {}) {
  const provider =
    options.provider || process.env.ROUTING_PROVIDER || "estimator";

  if (provider === "longdo") {
    const apiKey = options.apiKey || process.env.LONGDO_API_KEY;
    if (!apiKey) {
      console.warn(
        "[geocoding] ROUTING_PROVIDER=longdo but LONGDO_API_KEY is not set — falling back to estimator (shops without master coordinates will be left unresolved)."
      );
      return new EstimatorGeocoder();
    }
    return new LongdoGeocoder(apiKey, options);
  }

  return new EstimatorGeocoder();
}

/**
 * Resolve a shop's coordinates, applying the precedence in Requirement 2:
 *   1. numeric master `lat`/`long` that are not `(0,0)` -> use directly
 *      (source "master").
 *   2. otherwise geocode the address/name -> use if a usable, non-`(0,0)`
 *      location comes back (source "longdo").
 *   3. otherwise -> unresolved (source "unresolved") with a reason, so the
 *      caller can exclude the shop from routing and warn by identifier.
 *
 * Non-numeric and `(0,0)` coordinates are treated as unusable at every step
 * (Requirement 2.4). Output `location` is always `{ lat, lng }` (note the raw
 * master field is `long`, but resolved output uses `lng`).
 *
 * @param {object} shop  a ShopRecord (`shop.coordinates = { lat, long }`)
 * @param {{ geocode:(q:string)=>Promise<LatLng|null> }} geocoder
 * @returns {Promise<{ location: LatLng|null, resolved: boolean, source: string, reason?: string }>}
 */
export async function resolveShopCoordinates(shop, geocoder) {
  // Step 1 — master coordinates win when usable.
  const { lat, lng } = readRawCoords(shop);
  if (isUsablePair(lat, lng)) {
    return { location: { lat, lng }, resolved: true, source: "master" };
  }

  // Step 2 — geocode the address/name.
  const query = geocodeQuery(shop);
  let geocoded = null;
  if (query && geocoder && typeof geocoder.geocode === "function") {
    geocoded = await geocoder.geocode(query);
  }
  if (geocoded) {
    const gLat = toFiniteNumber(geocoded.lat);
    const gLng = toFiniteNumber(geocoded.lng !== undefined ? geocoded.lng : geocoded.long);
    if (isUsablePair(gLat, gLng)) {
      return { location: { lat: gLat, lng: gLng }, resolved: true, source: "longdo" };
    }
  }

  // Step 3 — unresolved.
  const id =
    (shop && (shop.customerCode ?? shop.id ?? shop.customer)) || "unknown";
  return {
    location: null,
    resolved: false,
    source: "unresolved",
    reason: `Unresolved coordinates for shop ${id}: no usable master lat/long and geocoding returned no usable location`,
  };
}

export { EstimatorGeocoder, LongdoGeocoder, DEFAULT_GEOCODE_URL };
