/**
 * Shared top-of-page progress bar (Farmhouse theme).
 *
 * A single thin bar is pinned to the top of the viewport and driven by every
 * async action across the app so the user always sees that something is
 * happening and how far along it is:
 *
 *   - `start()`         show the bar and begin an animated "trickle" toward a
 *                       ceiling (for actions with no real byte progress, e.g.
 *                       fetch requests).
 *   - `set(fraction)`   determinate mode: reflect real progress in [0..1]
 *                       (used for the file-upload phase via XHR upload events).
 *   - `indeterminate()` resume the trickle from the current position (used once
 *                       an upload finishes sending and the server is working).
 *   - `done()`          fill to 100% and fade out (success).
 *   - `fail()`          flash red and fade out (error).
 *
 * The bar element is injected lazily as the first child of <body>, so pages
 * need no markup — importing this module and calling the functions is enough.
 * Every function is null-safe and never throws.
 */

let barEl = null;
let fillEl = null;
let trickleTimer = null;
let hideTimer = null;
let resetTimer = null;
let current = 0; // current fill width in percent (0..100)
let ceiling = 90; // trickle target while indeterminate

function ensureEl() {
  if (barEl || typeof document === "undefined" || !document.body) return;
  barEl = document.createElement("div");
  barEl.className = "top-progress";
  barEl.setAttribute("role", "progressbar");
  barEl.setAttribute("aria-valuemin", "0");
  barEl.setAttribute("aria-valuemax", "100");
  barEl.setAttribute("aria-hidden", "true");

  fillEl = document.createElement("div");
  fillEl.className = "top-progress__fill";
  barEl.appendChild(fillEl);

  document.body.insertBefore(barEl, document.body.firstChild);
}

function setWidth(pct) {
  current = Math.max(0, Math.min(100, pct));
  if (fillEl) fillEl.style.width = `${current}%`;
  if (barEl) barEl.setAttribute("aria-valuenow", String(Math.round(current)));
}

/** Reset the fill to a starting width WITHOUT animating backwards. */
function resetWidth(pct) {
  if (!fillEl) return;
  fillEl.style.transition = "none";
  setWidth(pct);
  // Force a reflow so the transition-less reset is applied before re-enabling.
  void fillEl.offsetWidth;
  fillEl.style.transition = "";
}

function stopTrickle() {
  if (trickleTimer) {
    clearInterval(trickleTimer);
    trickleTimer = null;
  }
}

function clearAllTimers() {
  stopTrickle();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
}

function beginTrickle(top) {
  ceiling = top;
  if (trickleTimer) return;
  trickleTimer = setInterval(() => {
    const remaining = ceiling - current;
    if (remaining <= 0.4) return;
    // Ease-out: larger steps early, smaller as it approaches the ceiling.
    setWidth(current + Math.max(0.4, remaining * 0.08));
  }, 300);
}

export function start() {
  ensureEl();
  if (!barEl) return;
  clearAllTimers();
  barEl.classList.remove("err");
  barEl.classList.add("run");
  barEl.setAttribute("aria-hidden", "false");
  resetWidth(8);
  beginTrickle(90);
}

export function set(fraction) {
  ensureEl();
  if (!barEl) return;
  if (!barEl.classList.contains("run")) start();
  stopTrickle();
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  // Never reach 100% until done() so the bar can't "complete" before the result.
  setWidth(Math.min(99, pct));
}

export function indeterminate() {
  ensureEl();
  if (!barEl) return;
  if (!barEl.classList.contains("run")) start();
  beginTrickle(96);
}

function finish(isError) {
  if (!barEl) return;
  clearAllTimers();
  if (isError) barEl.classList.add("err");
  setWidth(100);
  hideTimer = setTimeout(
    () => {
      barEl.classList.remove("run"); // fade out via opacity transition
      barEl.setAttribute("aria-hidden", "true");
      resetTimer = setTimeout(() => {
        resetWidth(0);
        barEl.classList.remove("err");
      }, 300);
    },
    isError ? 550 : 250
  );
}

export function done() {
  finish(false);
}

export function fail() {
  finish(true);
}
