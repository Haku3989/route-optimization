/**
 * ETA (Estimated Time of Arrival) calculation.
 *
 * From the workshop "customer experience": drivers and dispatch want a
 * real-time ETA per stop. We derive ETAs from cumulative driving distance,
 * the vehicle's average speed, and a fixed service time per stop.
 */

import { drivingDistanceKm } from "../optimizer/distance.js";

const DEFAULT_SPEED_KMH = 35; // urban average
const SERVICE_MINUTES_PER_STOP = 8; // unloading / handover time

/** Delivery vehicles depart the depot at this wall-clock hour every day. */
const DEFAULT_DEPART_HOUR = 4;

/** `"YYYY-MM-DD"` for the server's LOCAL today. */
function todayDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The default route departure time: `DEFAULT_DEPART_HOUR:00` on the given
 * calendar day, or today when no `dateKey` is given.
 *
 * Built directly from an ISO string with an explicit "Z" so the resulting
 * Date's UTC time-of-day IS `DEFAULT_DEPART_HOUR:00` — this codebase does not
 * model real timezones end-to-end, so `etasFromLegs`'s window-checking (see
 * its docs) already relies on the convention that a `departAt`'s UTC
 * time-of-day represents the shop's LOCAL wall-clock time. Building it this
 * way here keeps that convention consistent instead of introducing a real
 * UTC+7 conversion in one call site only.
 *
 * @param {string|null} [dateKey] `"YYYY-MM-DD"`; falsy -> today
 * @returns {Date}
 */
export function defaultDepartAt(dateKey) {
  const key = dateKey || todayDateKey();
  return new Date(`${key}T${String(DEFAULT_DEPART_HOUR).padStart(2, "0")}:00:00.000Z`);
}

/**
 * Compute per-stop ETAs for a single route.
 *
 * @param {{lat:number,lng:number}} depot
 * @param {object} vehicle
 * @param {Array<{location:{lat:number,lng:number}}>} stops
 * @param {Date} departAt - when the vehicle leaves the depot
 * @returns {Array<{orderId:string, etaISO:string, cumulativeKm:number, cumulativeMin:number}>}
 */
export function computeETAs(depot, vehicle, stops, departAt = new Date()) {
  const speed = vehicle?.speedKmh || DEFAULT_SPEED_KMH;
  const result = [];

  let cumulativeKm = 0;
  let cumulativeMin = 0;
  let previous = depot;

  for (const stop of stops) {
    const legKm = drivingDistanceKm(previous, stop.location);
    cumulativeKm += legKm;
    cumulativeMin += (legKm / speed) * 60;

    const eta = new Date(departAt.getTime() + cumulativeMin * 60_000);

    result.push({
      orderId: stop.id,
      etaISO: eta.toISOString(),
      cumulativeKm: round(cumulativeKm),
      cumulativeMin: round(cumulativeMin),
    });

    // Add service time after arriving, before next leg.
    cumulativeMin += SERVICE_MINUTES_PER_STOP;
    previous = stop.location;
  }

  return result;
}

/**
 * Compute per-stop ETAs from pre-computed leg metrics (from the router).
 *
 * `legs[i]` is the travel from point i to point i+1 in the sequence
 * [depot, stop1, stop2, ..., stopN, depot]. Only the first N legs (arrivals)
 * are needed here; the final return-to-depot leg is ignored.
 *
 * ## Backward compatibility
 *
 * The original 3-argument form `etasFromLegs(stops, legs, departAt)` is
 * unchanged: each stop adds the default `SERVICE_MINUTES_PER_STOP` to the
 * cumulative clock and the returned entries carry exactly
 * `{ orderId, etaISO, cumulativeKm, cumulativeMin }`. Callers that pass stops
 * without a `serviceTimeMin` (e.g. the existing sample flow) see identical
 * results, and no extra fields are added unless `options.flagWindows` is set.
 *
 * ## Per-stop service time (Requirements 5.4, 7.2, 7.3)
 *
 * The service time added to the cumulative clock *after* arriving at a stop is
 * resolved as follows:
 *   - When `options.serviceMinutesFor(stop)` is supplied and returns a finite
 *     number, that value is used; otherwise it falls back to the default.
 *   - When no `serviceMinutesFor` is supplied, the stop's own
 *     `serviceTimeMin` is used when finite, else the default.
 * i.e. `serviceMin = options.serviceMinutesFor?.(stop) ?? stop.serviceTimeMin ?? SERVICE_MINUTES_PER_STOP`
 * (with non-finite results coalescing to the default).
 *
 * ## Time-window flagging (Requirement 7.1)
 *
 * When `options.flagWindows` is true, each entry additionally carries
 * `serviceMin` (the applied service minutes), `windowViolation` (boolean), and
 * `windowReason` (only present on a violation). A stop has a window only when
 * it defines both `openTime` and `closeTime` as `"HH:MM"` wall-clock strings;
 * a stop without a parseable window is never a violation. The window check
 * compares the ETA's **UTC** time-of-day (hours/minutes) against the inclusive
 * `[openTime, closeTime]` range. This mirrors how ETAs are reported (the
 * cumulative clock is added to `departAt` and read back in UTC), so callers
 * should provide `departAt` such that its UTC time-of-day represents the
 * shop's local business wall-clock.
 *
 * @param {Array} stops
 * @param {Array<{distanceKm:number,durationMin:number}>} legs
 * @param {Date} departAt
 * @param {{serviceMinutesFor?:(stop:object)=>number|undefined, flagWindows?:boolean}} [options]
 * @returns {Array<{orderId:string, etaISO:string, cumulativeKm:number, cumulativeMin:number, serviceMin?:number, windowViolation?:boolean, windowReason?:string}>}
 */
export function etasFromLegs(stops, legs, departAt = new Date(), options) {
  const flagWindows = Boolean(options && options.flagWindows);
  const result = [];
  let cumulativeKm = 0;
  let cumulativeMin = 0;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const leg = legs[i] || { distanceKm: 0, durationMin: 0 };
    cumulativeKm += leg.distanceKm;
    cumulativeMin += leg.durationMin;

    const eta = new Date(departAt.getTime() + cumulativeMin * 60_000);
    const serviceMin = resolveServiceMin(stop, options);

    const entry = {
      orderId: stop.id,
      etaISO: eta.toISOString(),
      cumulativeKm: round(cumulativeKm),
      cumulativeMin: round(cumulativeMin),
    };

    if (flagWindows) {
      const { violation, reason } = checkWindow(eta, stop);
      entry.serviceMin = serviceMin;
      entry.windowViolation = violation;
      if (reason) entry.windowReason = reason;
    }

    result.push(entry);

    // Service time is applied after arrival, before the next leg.
    cumulativeMin += serviceMin;
  }

  return result;
}

/**
 * Resolve the per-stop service minutes.
 *
 * Precedence: an explicit `options.serviceMinutesFor(stop)` (when it returns a
 * finite number) wins; otherwise the stop's own `serviceTimeMin` (when finite);
 * otherwise the default `SERVICE_MINUTES_PER_STOP`.
 */
function resolveServiceMin(stop, options) {
  if (options && typeof options.serviceMinutesFor === "function") {
    const value = options.serviceMinutesFor(stop);
    if (Number.isFinite(value)) return value;
    return SERVICE_MINUTES_PER_STOP;
  }
  if (stop && Number.isFinite(stop.serviceTimeMin)) return stop.serviceTimeMin;
  return SERVICE_MINUTES_PER_STOP;
}

/**
 * Determine whether an ETA violates a stop's `[openTime, closeTime]` window.
 * Returns `{ violation:false }` when the stop has no parseable window.
 */
function checkWindow(eta, stop) {
  const openMin = parseClockMinutes(stop && stop.openTime);
  const closeMin = parseClockMinutes(stop && stop.closeTime);
  if (openMin == null || closeMin == null) {
    return { violation: false };
  }

  const todMin = eta.getUTCHours() * 60 + eta.getUTCMinutes();
  if (todMin < openMin) {
    return { violation: true, reason: `ETA ${formatClock(todMin)} is before open ${formatClock(openMin)}` };
  }
  if (todMin > closeMin) {
    return { violation: true, reason: `ETA ${formatClock(todMin)} is after close ${formatClock(closeMin)}` };
  }
  return { violation: false };
}

/**
 * Parse a `"HH:MM"` wall-clock string into minutes-of-day, or `null` when the
 * value is missing or malformed.
 */
function parseClockMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(totalMin) {
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export const ETA_CONFIG = { DEFAULT_SPEED_KMH, SERVICE_MINUTES_PER_STOP, DEFAULT_DEPART_HOUR };
