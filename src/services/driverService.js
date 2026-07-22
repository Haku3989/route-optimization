/**
 * Driver service — authentication, assigned-route retrieval, and stop
 * advancement (Requirements 8.3, 10.1, 10.2, 10.3).
 *
 * This service is the glue between the pure credential/token helpers in
 * `auth/credentials.js`, the persisted driver/session rows in the repository
 * layer, and the driver-facing route view. It is deliberately kept thin and
 * dependency-injectable so it can be property-tested with in-memory fakes and
 * never requires a live database.
 *
 * ## Dependency injection (`deps` bag)
 *
 * Every function accepts an optional `deps` object so tests can substitute
 * fakes for the persistence + crypto seams:
 *   - `repositories`     — defaults to the real `../db/repositories.js`
 *                          (`findDriverByUsername`, `insertSession`,
 *                          `findSession`, `deleteSession`).
 *   - `verifyPassword`   — defaults to the real timing-safe verifier.
 *   - `newToken`         — defaults to the real 32-byte hex token minter.
 *   - `getRouteForDriver`— an injectable route provider `(driverId) => route`.
 *
 * ## Route assembly note (getDriverRoute)
 *
 * Per the design, `drivers.route_id` links a driver to a route, but plan/route
 * persistence is out of scope for this service. `getDriverRoute` therefore
 * resolves the caller's token to a `driverId` and delegates the actual route
 * lookup to an injectable provider (`deps.getRouteForDriver`). This keeps the
 * auth boundary (the security-relevant part) fully testable here while leaving
 * route storage to a later task / the API layer. Crucially, when a request is
 * unauthenticated the provider is NEVER consulted, so no route or stop data can
 * leak (Requirement 10.3).
 *
 * ## Security choices (stated explicitly)
 *   - Any login failure — unknown username OR bad password OR malformed input —
 *     throws the SAME generic `AuthError`, so a caller cannot tell which field
 *     was wrong (Requirement 10.2).
 *   - Passwords are checked with the timing-safe `verifyPassword`; the plaintext
 *     is never stored or logged.
 *   - `resolveToken` treats an absent OR expired session as unauthenticated
 *     (Requirement 10.3).
 */

import * as realRepositories from "../db/repositories.js";
import {
  AuthError,
  verifyPassword as realVerifyPassword,
  newToken as realNewToken,
} from "../auth/credentials.js";
import { classifyDeviation } from "./onTimeClassification.js";

/**
 * Terminal marker for a route's current stop: `null` means there is no next
 * uncompleted stop (the route is finished). `advanceStop` sets `currentSequence`
 * to this when nothing remains after the completed stop.
 */
const ROUTE_COMPLETE = null;

/** `"YYYY-MM-DD"` for a Date's LOCAL calendar day (mirrors the same
 * local-getter convention used elsewhere in this app, e.g.
 * `historyService.js`'s `toDateKey` — avoids the UTC-shift bug documented
 * there). Exported so `driverRoutes.js`'s route assembly can compute the
 * same "today" key when checking for already-completed stops. */
export function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Authenticate a driver and issue a persisted bearer token (Req 10.1, 10.2).
 *
 * On ANY failure (unknown username, wrong password, or a driver row with a
 * malformed hash) this throws a generic {@link AuthError} whose message reveals
 * neither field. A token is only minted and persisted after a successful
 * password check, so a failed login never creates a session.
 *
 * @param {string} username submitted employee username
 * @param {string} password submitted plaintext password
 * @param {{ repositories?: object, verifyPassword?: Function, newToken?: Function }} [deps]
 * @returns {Promise<{ token: string, driverId: number }>}
 * @throws {AuthError} on any authentication failure
 */
export async function login(username, password, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const verify = deps.verifyPassword || realVerifyPassword;
  const mintToken = deps.newToken || realNewToken;

  const driver = await repositories.findDriverByUsername(username);
  // Unknown username -> generic denial (do not reveal that the user is unknown).
  if (!driver) {
    throw new AuthError();
  }
  // Wrong password -> the SAME generic denial (indistinguishable from above).
  if (!verify(password, driver.passwordHash)) {
    throw new AuthError();
  }

  const token = mintToken();
  await repositories.insertSession(token, driver.id);
  return { token, driverId: driver.id };
}

/**
 * Resolve a bearer token to the owning driver id, or `null` when the token is
 * not a currently valid session (Req 10.3).
 *
 * Returns `null` when:
 *   - the token is missing / not a non-empty string,
 *   - no session row exists for it, or
 *   - the session has an `expiresAt` that is at/before now.
 *
 * @param {unknown} token the bearer token to resolve
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<number|null>} the driver id, or `null` when unauthenticated
 */
export async function resolveToken(token, deps = {}) {
  const repositories = deps.repositories || realRepositories;

  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const session = await repositories.findSession(token);
  if (!session) {
    return null;
  }

  // Treat an expired session as unauthenticated. A null/absent expiresAt means
  // the session does not expire on a timestamp basis.
  if (session.expiresAt != null) {
    const expires =
      session.expiresAt instanceof Date
        ? session.expiresAt
        : new Date(session.expiresAt);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) {
      return null;
    }
  }

  return session.driverId;
}

/**
 * Return the assigned route for the authenticated caller, or throw
 * {@link AuthError} when the token is invalid (Req 10.3).
 *
 * The token is resolved to a `driverId` FIRST; only when that succeeds is the
 * injected route provider consulted. When the token is invalid the provider is
 * never called, so no route or stop information is produced for an
 * unauthenticated request.
 *
 * @param {unknown} token bearer token from the `Authorization: Bearer` header
 * @param {{ repositories?: object, getRouteForDriver?: (driverId:number) => any }} [deps]
 * @returns {Promise<{ route: any }>}
 * @throws {AuthError} when the token does not resolve to a valid session
 */
export async function getDriverRoute(token, deps = {}) {
  const driverId = await resolveToken(token, deps);
  if (driverId == null) {
    // Unauthenticated: deny access and return NO route/stop data (Req 10.3).
    throw new AuthError();
  }

  const getRouteForDriver = deps.getRouteForDriver;
  if (typeof getRouteForDriver !== "function") {
    // Route/plan persistence is out of scope for this service; the caller must
    // inject a provider that maps a driverId to its assigned route.
    throw new Error(
      "driverService.getDriverRoute requires deps.getRouteForDriver(driverId)"
    );
  }

  const route = await getRouteForDriver(driverId);
  return { route };
}

/**
 * Advance a route after a stop is completed (Req 8.3). Pure and non-mutating.
 *
 * Marks the stop at `completedSeq` as `completed` and sets `currentSequence` to
 * the FIRST uncompleted stop whose sequence is greater than `completedSeq` (in
 * ascending sequence order). When no uncompleted stop remains after it, the
 * route is finished and `currentSequence` is set to {@link ROUTE_COMPLETE}
 * (`null`).
 *
 * The input `route` and its `stops` are never mutated: a shallow clone of the
 * route with cloned stop objects is returned.
 *
 * @param {{ stops: Array<{ sequence: number, completed?: boolean }>,
 *           currentSequence?: number|null }} route
 * @param {number} completedSeq sequence number of the stop just completed
 * @returns {{ stops: Array<object>, currentSequence: number|null }} the new route
 */
export function advanceStop(route, completedSeq) {
  const sourceStops = Array.isArray(route?.stops) ? route.stops : [];

  // Clone every stop so the caller's objects are untouched; mark the completed
  // one as completed along the way.
  const stops = sourceStops.map((stop) => {
    const clone = { ...stop };
    if (clone.sequence === completedSeq) {
      clone.completed = true;
    }
    return clone;
  });

  // The next current stop is the first (lowest sequence) stop after completedSeq
  // that is still not completed.
  const nextStop = stops
    .filter((stop) => stop.sequence > completedSeq && !stop.completed)
    .sort((a, b) => a.sequence - b.sequence)[0];

  const currentSequence = nextStop ? nextStop.sequence : ROUTE_COMPLETE;

  return { ...route, stops, currentSequence };
}

/**
 * Mark one of the authenticated driver's stops complete: persists a
 * `delivery_completions` row snapshotting the stop's own planned ETA against
 * the actual completion moment, classified early/on-time/late via the shared
 * `onTimeClassification.js` (the same rule the admin daily report uses).
 *
 * The token is resolved to a `driverId` FIRST, mirroring `getDriverRoute` —
 * the route provider is never consulted for an unauthenticated request.
 *
 * @param {unknown} token bearer token from the `Authorization: Bearer` header
 * @param {string} customerCode the stop's `customerCode` (== the plan's `orderId`)
 * @param {{ repositories?: object, getRouteForDriver?: (driverId:number) => any, now?: () => Date }} [deps]
 * @returns {Promise<{ completedAt:string, scheduledEta:string|null,
 *   deviationMin:number|null, category:string|null } | { message:string }>}
 * @throws {AuthError} when the token does not resolve to a valid session
 */
export async function completeStop(token, customerCode, deps = {}) {
  const driverId = await resolveToken(token, deps);
  if (driverId == null) {
    throw new AuthError();
  }

  const repositories = deps.repositories || realRepositories;
  const getRouteForDriver = deps.getRouteForDriver;
  if (typeof getRouteForDriver !== "function") {
    throw new Error("driverService.completeStop requires deps.getRouteForDriver(driverId)");
  }
  const now = deps.now ? deps.now() : new Date();

  const route = await getRouteForDriver(driverId);
  const stop = (route?.stops || []).find((s) => s.customerCode === customerCode);
  if (!stop) {
    // The plan may have been rebuilt since the driver loaded the page — not an
    // auth failure, just nothing to record against.
    return { message: "stop not found in current route" };
  }

  const parsedEta = stop.eta ? new Date(stop.eta) : null;
  const scheduledEta = parsedEta && !Number.isNaN(parsedEta.getTime()) ? parsedEta : null;
  const deviationMin = scheduledEta ? Math.round((now.getTime() - scheduledEta.getTime()) / 60000) : null;
  const category = classifyDeviation(deviationMin);
  const day = localDayKey(now);

  await repositories.upsertDeliveryCompletion({
    driverId,
    routeId: route.routeId,
    customerCode,
    customerName: stop.customer ?? null,
    scheduledEta,
    completedAt: now,
    deviationMin,
    category,
    day,
  });

  return {
    completedAt: now.toISOString(),
    scheduledEta: scheduledEta ? scheduledEta.toISOString() : null,
    deviationMin,
    category,
  };
}

/**
 * Aggregate the authenticated driver's completions for one local day
 * (defaults to today) into an early/on-time/late summary.
 *
 * @param {unknown} token bearer token
 * @param {{ day?:string, repositories?: object, now?: () => Date }} [deps]
 * @returns {Promise<{ day:string, completed:number, early:number, onTime:number,
 *   late:number, earlyPct:number, onTimePct:number, latePct:number,
 *   avgDeviationMin:number|null }>}
 * @throws {AuthError} when the token does not resolve to a valid session
 */
export async function getDriverDaySummary(token, deps = {}) {
  const driverId = await resolveToken(token, deps);
  if (driverId == null) {
    throw new AuthError();
  }

  const repositories = deps.repositories || realRepositories;
  const now = deps.now ? deps.now() : new Date();
  const day = deps.day || localDayKey(now);

  const completions = await repositories.deliveryCompletionsForDriverDay(driverId, day);

  let early = 0;
  let onTime = 0;
  let late = 0;
  let deviationSum = 0;
  let deviationCount = 0;
  for (const c of completions) {
    if (c.category === "early") early += 1;
    else if (c.category === "on_time") onTime += 1;
    else if (c.category === "late") late += 1;
    if (Number.isFinite(c.deviationMin)) {
      deviationSum += c.deviationMin;
      deviationCount += 1;
    }
  }

  const completed = completions.length;
  const pct = (n) => (completed > 0 ? Math.round((n / completed) * 1000) / 10 : 0);

  return {
    day,
    completed,
    early,
    onTime,
    late,
    earlyPct: pct(early),
    onTimePct: pct(onTime),
    latePct: pct(late),
    avgDeviationMin: deviationCount > 0 ? Math.round((deviationSum / deviationCount) * 100) / 100 : null,
  };
}
