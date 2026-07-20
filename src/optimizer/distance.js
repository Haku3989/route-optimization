/**
 * Geographic distance helpers.
 *
 * Uses the Haversine formula for great-circle distance between two
 * lat/lng points, then applies a road-network detour factor so the
 * estimate is closer to real driving distance than straight-line.
 */

const EARTH_RADIUS_KM = 6371;

// Real roads are longer than straight lines. ~1.3 is a common urban factor.
const ROAD_DETOUR_FACTOR = 1.3;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two points in kilometers.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} kilometers
 */
export function haversineKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Estimated driving distance in kilometers (Haversine + detour factor).
 */
export function drivingDistanceKm(a, b) {
  return haversineKm(a, b) * ROAD_DETOUR_FACTOR;
}

/**
 * Build a symmetric distance matrix (km) for a list of points.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {number[][]}
 */
export function buildDistanceMatrix(points) {
  const n = points.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = drivingDistanceKm(points[i], points[j]);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }
  return matrix;
}
