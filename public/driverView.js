/**
 * Driver view — PURE view logic (Requirements 8.1, 8.3, 8.4, 8.5, 9.1, 9.2, 9.4).
 *
 * This module is the single source of truth for the driver-view behaviour that
 * can be reasoned about without a browser: building Google Maps navigation
 * links, ordering/shaping the stop list, deciding when the empty-plan message
 * shows, and advancing the current stop.
 *
 * IMPORTANT: this module performs NO DOM access at import time (no `document`,
 * no `window`). It is a plain ES module that runs identically in the browser
 * (imported by `public/driver.js`) and under Node's `node:test` runner
 * (imported by `tests/driverView.test.js`) and is imported by the server
 * (`src/routes/driverRoutes.js`) so `buildMapsUrl` has ONE definition. All DOM
 * wiring lives in `public/driver.js`, which imports from here and injects the
 * concrete render operations into {@link renderRoute}.
 */

/** Message shown when the assigned plan contains zero stops (Req 8.4). */
export const EMPTY_MESSAGE = "No stops to deliver.";

/** Fallback shown when even the empty-plan message cannot be rendered (Req 8.5). */
export const FALLBACK_MESSAGE = "Plan could not be loaded.";

const MAPS_BASE = "https://www.google.com/maps/dir/?api=1&destination=";

/**
 * Build a Google Maps navigation URL for a stop (Req 9.1, 9.2, 9.4).
 *
 *   - coordinates present -> destination is `"<lat>,<lng>"` (Req 9.1)
 *   - address only (no usable coords) -> destination is the URL-encoded address (Req 9.2)
 *   - neither -> `null`, so the view shows the coords/address as fallback text (Req 9.4)
 *
 * A coordinate pair is "usable" when both `lat` and `lng` are finite numbers.
 * `(0,0)` is intentionally still treated as a usable coordinate here — the
 * ingestion layer is responsible for discarding suspicious `(0,0)` shops before
 * they ever reach a route (Requirement 2.4), so any coordinates that arrive at
 * the driver view are already trusted.
 *
 * @param {{ location?: {lat:number,lng:number}|null, address?: string|null }} stop
 * @returns {string|null} the maps URL, or `null` when no destination is derivable
 */
export function buildMapsUrl(stop) {
  const loc = stop && stop.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return `${MAPS_BASE}${loc.lat},${loc.lng}`;
  }
  const address = stop && stop.address;
  if (typeof address === "string" && address.trim() !== "") {
    return `${MAPS_BASE}${encodeURIComponent(address.trim())}`;
  }
  return null;
}

/**
 * Plain-text navigation fallback for a stop whose maps link could not be built,
 * or to display alongside the link (Req 9.4). Returns the coordinates, then the
 * address, else a generic "unavailable" note.
 *
 * @param {{ location?: {lat:number,lng:number}|null, address?: string|null }} stop
 * @returns {string}
 */
export function stopNavFallbackText(stop) {
  const loc = stop && stop.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return `${loc.lat}, ${loc.lng}`;
  }
  const address = stop && stop.address;
  if (typeof address === "string" && address.trim() !== "") {
    return address.trim();
  }
  return "Location unavailable";
}

/**
 * Count the stops in a plan/route in a null-safe way.
 * @param {{ stops?: Array }|null|undefined} plan
 * @returns {number}
 */
function countStops(plan) {
  if (!plan || !Array.isArray(plan.stops)) return 0;
  return plan.stops.length;
}

/**
 * Decide whether the "no stops to deliver" message should be shown (Req 8.4).
 * True IFF the plan contains zero stops; any non-empty plan returns false.
 *
 * @param {{ stops?: Array }|null|undefined} plan
 * @returns {boolean}
 */
export function shouldShowEmptyMessage(plan) {
  return countStops(plan) === 0;
}

/**
 * Shape a route into an ordered list of stop view-models (Req 8.1). The result
 * is ordered by non-decreasing `sequence`, and each entry carries the customer
 * name, ETA, a maps URL (or `null`), and fallback nav text so the DOM layer can
 * render without any further ordering logic. Pure and non-mutating.
 *
 * `category`/`deviationMin` are additive: present once a stop has been marked
 * complete (persisted server-side, see `driverService.completeStop`) so the
 * badge survives a page refresh — `null` for a not-yet-completed stop.
 *
 * @param {{ stops?: Array<object>, currentSequence?: number|null }} route
 * @returns {Array<{ sequence:number, customerCode:(string|null), customer:(string|null), eta:(string|null),
 *   completed:boolean, isCurrent:boolean, mapsUrl:(string|null), fallbackText:string,
 *   location:(object|null), address:(string|null), category:(string|null),
 *   deviationMin:(number|null) }>}
 */
export function renderStopList(route) {
  const stops = route && Array.isArray(route.stops) ? route.stops : [];
  const currentSequence =
    route && route.currentSequence != null ? route.currentSequence : null;

  return stops
    .slice()
    .sort((a, b) => seqValue(a) - seqValue(b))
    .map((stop) => {
      const mapsUrl = buildMapsUrl(stop);
      return {
        sequence: stop.sequence,
        customerCode: stop.customerCode ?? null,
        customer: stop.customer ?? null,
        eta: stop.eta ?? null,
        completed: Boolean(stop.completed),
        isCurrent: stop.sequence === currentSequence,
        mapsUrl,
        fallbackText: stopNavFallbackText(stop),
        location: stop.location ?? null,
        address: stop.address ?? null,
        category: stop.category ?? null,
        deviationMin: Number.isFinite(stop.deviationMin) ? stop.deviationMin : null,
      };
    });
}

/**
 * Numeric sort key for a stop's sequence; stops without a finite sequence sort
 * to the front deterministically.
 */
function seqValue(stop) {
  return stop && Number.isFinite(stop.sequence)
    ? stop.sequence
    : Number.NEGATIVE_INFINITY;
}

/**
 * Advance a route after the current stop is completed (Req 8.3). Pure and
 * non-mutating — mirrors the server-side `driverService.advanceStop` so the UI
 * advances optimistically without a round-trip.
 *
 * Marks the stop at `completedSeq` as `completed` and sets `currentSequence` to
 * the FIRST uncompleted stop whose sequence is greater than `completedSeq`
 * (ascending). When none remain, `currentSequence` becomes `null` (route done).
 *
 * @param {{ stops?: Array<{sequence:number, completed?:boolean}>, currentSequence?:number|null }} route
 * @param {number} completedSeq sequence number of the stop just completed
 * @returns {{ stops: Array<object>, currentSequence: number|null }}
 */
export function advanceStop(route, completedSeq) {
  const sourceStops = route && Array.isArray(route.stops) ? route.stops : [];

  const stops = sourceStops.map((stop) => {
    const clone = { ...stop };
    if (clone.sequence === completedSeq) clone.completed = true;
    return clone;
  });

  const nextStop = stops
    .filter((stop) => stop.sequence > completedSeq && !stop.completed)
    .sort((a, b) => a.sequence - b.sequence)[0];

  return {
    ...route,
    stops,
    currentSequence: nextStop ? nextStop.sequence : null,
  };
}

/**
 * Render orchestrator (Req 8.1, 8.4, 8.5). Decides WHAT to show and delegates
 * the actual painting to an injected `ops` bag so the decision logic stays pure
 * and DOM-free (and therefore unit-testable):
 *
 *   - zero stops           -> `ops.showEmpty()`             (Req 8.4)
 *   - one or more stops    -> `ops.showStops(viewModels)`   (Req 8.1)
 *   - any of the above throws while painting -> `ops.showFallback(err)` (Req 8.5)
 *
 * The empty-plan message is shown ONLY when there are zero stops. If painting
 * the chosen content throws (e.g. the empty message cannot be displayed), the
 * fallback "plan could not be loaded" content is shown instead.
 *
 * @param {{ stops?: Array<object>, currentSequence?: number|null }} route
 * @param {{ showEmpty: () => void, showStops: (vm:Array<object>) => void,
 *           showFallback: (err?:unknown) => void }} ops
 * @returns {"empty"|"stops"|"error"} which branch was rendered
 */
export function renderRoute(route, ops) {
  try {
    if (shouldShowEmptyMessage(route)) {
      ops.showEmpty();
      return "empty";
    }
    ops.showStops(renderStopList(route));
    return "stops";
  } catch (err) {
    // Req 8.5: the chosen content could not be rendered — fall back.
    ops.showFallback(err);
    return "error";
  }
}
