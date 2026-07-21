/* Farmhouse Driver — mobile view controller (Requirements 8, 9, 10).
 *
 * This is the DOM/network layer. ALL testable view logic lives in the pure
 * `driverView.js` module (imported below); this file only wires that logic to
 * the DOM, `fetch`, and `sessionStorage`.
 *
 * Flow:
 *   1. While unauthenticated, only the login form is shown (Req 10.3).
 *   2. Login POSTs to /api/driver/login; the token is kept in memory AND in
 *      sessionStorage so a refresh keeps the driver signed in (Req 10.1).
 *   3. The route is fetched from /api/driver/route with a Bearer token and
 *      rendered via renderRoute(): stops in sequence with name + ETA, current
 *      stop highlighted, empty-plan message, and a fallback if rendering fails.
 */

import {
  renderRoute,
  renderStopList,
  advanceStop,
  EMPTY_MESSAGE,
  FALLBACK_MESSAGE,
} from "./driverView.js";
import * as progress from "./progress.js";

const TOKEN_KEY = "farmhouse.driver.token";

let token = null;
let currentRoute = null;

// --- DOM handles -----------------------------------------------------------
const loginView = document.getElementById("loginView");
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");

const routeView = document.getElementById("routeView");
const routeMeta = document.getElementById("routeMeta");
const driverMapEl = document.getElementById("driverMap");
const stopList = document.getElementById("stopList");
const routeMessage = document.getElementById("routeMessage");
const logoutBtn = document.getElementById("logoutBtn");

const summaryBtn = document.getElementById("summaryBtn");
const summaryPanel = document.getElementById("summaryPanel");
const summaryContent = document.getElementById("summaryContent");

// --- Render operations injected into the pure renderRoute() ----------------
const ops = {
  showEmpty() {
    // Req 8.4: exactly the "no stops to deliver" message, only when zero stops.
    stopList.innerHTML = "";
    routeMessage.textContent = EMPTY_MESSAGE;
    routeMessage.hidden = false;
  },
  showStops(viewModels) {
    routeMessage.hidden = true;
    routeMessage.textContent = "";
    stopList.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const vm of viewModels) frag.appendChild(buildStopEl(vm));
    stopList.appendChild(frag);
  },
  showFallback() {
    // Req 8.5: even the empty message could not be shown -> fallback content.
    stopList.innerHTML = "";
    routeMessage.textContent = FALLBACK_MESSAGE;
    routeMessage.hidden = false;
  },
};

// --- Rendering helpers ------------------------------------------------------

/** Format an ISO timestamp as HH:MM, or a dash when absent. */
function fmtTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Anchor markup for a Google Maps link. No user data is interpolated — the href
 * is a safe https URL (coordinates are numbers; addresses are percent-encoded
 * by buildMapsUrl) and the label is static — so this template cannot inject
 * markup. Req 9.3: open in a new context with rel="noopener".
 */
function mapsLinkHtml(mapsUrl) {
  return `<a class="maps-link" href="${mapsUrl}" target="_blank" rel="noopener">Open in Maps</a>`;
}

/** Status badge for a completed stop's early/on-time/late category, or `null`
 * when there's nothing to show yet (not completed, or no ETA to compare against). */
function categoryBadge(category, deviationMin) {
  if (!category) return null;
  const span = document.createElement("span");
  if (category === "early") {
    span.className = "status-early";
    span.textContent = Number.isFinite(deviationMin) ? `${Math.abs(deviationMin)} min early` : "Early";
  } else if (category === "late") {
    span.className = "status-late";
    span.textContent = Number.isFinite(deviationMin) ? `${deviationMin} min late` : "Late";
  } else {
    span.className = "status-on-time";
    span.textContent = "On time";
  }
  return span;
}

/** Build a single stop <li> from a view-model produced by renderStopList(). */
function buildStopEl(vm) {
  const li = document.createElement("li");
  li.className = "stop";
  if (vm.customerCode != null) li.dataset.customerCode = vm.customerCode;
  if (vm.isCurrent) li.classList.add("current");
  if (vm.completed) li.classList.add("completed");

  const head = document.createElement("div");
  head.className = "stop-head";

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = vm.sequence == null ? "" : String(vm.sequence);
  head.appendChild(seq);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = vm.customer == null ? "(unnamed)" : vm.customer;
  head.appendChild(name);

  if (vm.isCurrent) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Current";
    head.appendChild(badge);
  }
  li.appendChild(head);

  const eta = document.createElement("div");
  eta.className = "eta";
  eta.textContent = `ETA ${fmtTime(vm.eta)}`;
  li.appendChild(eta);

  const badge = categoryBadge(vm.category, vm.deviationMin);
  if (badge) {
    badge.classList.add("status-badge");
    li.appendChild(badge);
  }

  const actions = document.createElement("div");
  actions.className = "stop-actions";

  if (vm.mapsUrl) {
    actions.insertAdjacentHTML("beforeend", mapsLinkHtml(vm.mapsUrl));
  } else {
    // Req 9.4: no maps link -> show coordinates/address as fallback nav text.
    const fb = document.createElement("div");
    fb.className = "nav-fallback";
    fb.textContent = vm.fallbackText;
    li.appendChild(fb);
  }

  if (vm.isCurrent && !vm.completed) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "complete-btn";
    btn.textContent = "Mark complete";
    btn.addEventListener("click", () => onComplete(vm.sequence, vm.customerCode, btn));
    actions.appendChild(btn);
  }

  if (actions.childNodes.length > 0) li.appendChild(actions);
  return li;
}

/** Render the current route into the DOM via the pure orchestrator. */
function render(route) {
  currentRoute = route;
  const stopCount = route && Array.isArray(route.stops) ? route.stops.length : 0;
  routeMeta.textContent = stopCount === 0 ? "" : `${stopCount} stops on your route`;
  renderRoute(route, ops);
  renderMap(route);
}

// --- Route preview map -------------------------------------------------------
// Same visual language as the dashboard map (public/app.js): numbered
// markers, real road-following lines per leg with a straight-line fallback.
// Difference: a marker's info shows on TAP (Leaflet's default click trigger
// for bindPopup), not hover — there's no hover state on a phone.

let driverMap = null;
let driverLayerGroup = null;
const ROUTE_COLOR = getComputedStyle(document.documentElement)
  .getPropertyValue("--color-accent")
  .trim();
const CURRENT_STOP_COLOR = getComputedStyle(document.documentElement)
  .getPropertyValue("--color-gold")
  .trim();

function ensureMap() {
  if (driverMap) return;
  driverMap = L.map("driverMap", { attributionControl: false }).setView([13.7563, 100.5018], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(driverMap);
  driverLayerGroup = L.layerGroup().addTo(driverMap);
}

function numberedIcon(number, color) {
  return L.divIcon({
    className: "route-marker",
    html: `<span class="route-marker-dot" style="background:${color}">${number}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/** Popup content built as DOM nodes (never an HTML string) so a customer
 * name can never be interpreted as markup. */
function stopPopupContent(vm) {
  const wrap = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = vm.customer == null ? "(unnamed)" : vm.customer;
  wrap.appendChild(name);
  wrap.appendChild(document.createElement("br"));
  wrap.appendChild(document.createTextNode(`ETA ${fmtTime(vm.eta)}`));
  return wrap;
}

/** One polyline per leg, using that leg's real geometry when available and
 * falling back to a straight line otherwise — mirrors app.js's drawRouteLine. */
function drawRouteLine(points, legsGeometry, style) {
  for (let i = 0; i < points.length - 1; i++) {
    const legPoints = legsGeometry?.[i];
    const line =
      Array.isArray(legPoints) && legPoints.length > 0
        ? legPoints.map((p) => [p.lat, p.lng])
        : [points[i], points[i + 1]];
    L.polyline(line, style).addTo(driverLayerGroup);
  }
}

function usableLocation(loc) {
  return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
}

/** Draw the driver's own route: depot, numbered stop markers (tap for info),
 * and the connecting line. Hidden entirely when there are no stops. */
function renderMap(route) {
  const stopCount = route && Array.isArray(route.stops) ? route.stops.length : 0;
  driverMapEl.hidden = stopCount === 0;
  if (stopCount === 0) return;

  ensureMap();
  driverLayerGroup.clearLayers();

  const bounds = [];
  const line = [];
  const depot = route.depot;
  if (usableLocation(depot)) {
    L.marker([depot.lat, depot.lng], { title: "Depot" }).addTo(driverLayerGroup);
    bounds.push([depot.lat, depot.lng]);
    line.push([depot.lat, depot.lng]);
  }

  for (const vm of renderStopList(route)) {
    if (!usableLocation(vm.location)) continue;
    const { lat, lng } = vm.location;
    bounds.push([lat, lng]);
    line.push([lat, lng]);
    L.marker([lat, lng], { icon: numberedIcon(vm.sequence, vm.isCurrent ? CURRENT_STOP_COLOR : ROUTE_COLOR) })
      .bindPopup(stopPopupContent(vm))
      .addTo(driverLayerGroup);
  }

  if (usableLocation(depot)) line.push([depot.lat, depot.lng]);

  drawRouteLine(line, route.routeGeometry, { color: ROUTE_COLOR, weight: 4, opacity: 0.85 });

  // The map may have just been un-hidden — Leaflet needs a nudge to size
  // itself correctly after its container's dimensions become non-zero.
  driverMap.invalidateSize();
  if (bounds.length > 1) driverMap.fitBounds(bounds, { padding: [24, 24] });
  else if (bounds.length === 1) driverMap.setView(bounds[0], 14);
}

/**
 * Mark a stop complete: persist it server-side first (so the early/on-time/
 * late status is real and survives a refresh — see `driverRoutes.js`'s
 * `POST /complete`), then advance the route optimistically via the pure
 * `advanceStop` on success. The button is disabled for the round-trip so a
 * double-tap can't fire two requests.
 */
async function onComplete(sequence, customerCode, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/driver/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customerCode }),
    });
    if (res.status === 401) {
      clearToken();
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok || data.message) {
      // Stop no longer in the current route (e.g. plan was rebuilt) or a
      // server error — reload the real route rather than trusting stale local state.
      await loadRoute();
      return;
    }
    // Stamp the completed stop's real category/deviation onto the current
    // route before advancing, so the badge shows immediately.
    currentRoute = {
      ...currentRoute,
      stops: currentRoute.stops.map((s) =>
        s.sequence === sequence ? { ...s, category: data.category, deviationMin: data.deviationMin } : s
      ),
    };
    currentRoute = advanceStop(currentRoute, sequence);
    render(currentRoute);
    // Pulse ONLY the badge that just appeared (not the whole list) — a single
    // "something just happened" moment, not scattered motion across every
    // already-completed stop from a previous session.
    const justCompletedStop = stopList.querySelector(`[data-customer-code="${CSS.escape(customerCode)}"] .status-badge`);
    if (justCompletedStop) justCompletedStop.classList.add("pulse-once");
  } catch (_) {
    if (btn) btn.disabled = false;
  }
}

// --- View switching ---------------------------------------------------------
function showLogin() {
  // Req 10.3: while unauthenticated, show ONLY the login form — no route data.
  routeView.hidden = true;
  loginView.hidden = false;
  logoutBtn.hidden = true;
  stopList.innerHTML = "";
  routeMessage.hidden = true;
  routeMessage.textContent = "";
  routeMeta.textContent = "";
  summaryPanel.hidden = true;
  summaryContent.innerHTML = "";
}

function showRouteView() {
  loginView.hidden = true;
  routeView.hidden = false;
  logoutBtn.hidden = false;
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.hidden = true;
  loginError.textContent = "";
}

// --- Token storage ----------------------------------------------------------
function setToken(value) {
  token = value;
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
  } catch (_) {
    /* sessionStorage may be unavailable (private mode) — memory token still works. */
  }
}

function getStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch (_) {
    return null;
  }
}

function clearToken() {
  token = null;
  currentRoute = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* ignore */
  }
}

// --- Network ----------------------------------------------------------------
async function handleLogin(event) {
  event.preventDefault();
  hideLoginError();
  loginBtn.disabled = true;
  progress.start();
  try {
    const res = await fetch("/api/driver/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameEl.value,
        password: passwordEl.value,
      }),
    });
    if (!res.ok) {
      // Generic message — the server never reveals which field was wrong (Req 10.2).
      progress.fail();
      showLoginError("Invalid username or password.");
      return;
    }
    const data = await res.json();
    setToken(data.token);
    passwordEl.value = "";
    showRouteView();
    await loadRoute();
    progress.done();
  } catch (_) {
    progress.fail();
    showLoginError("Could not sign in. Check your connection and try again.");
  } finally {
    loginBtn.disabled = false;
  }
}

async function loadRoute() {
  try {
    const res = await fetch("/api/driver/route", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Session invalid/expired -> drop back to the login form (Req 10.3).
      clearToken();
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`route request failed: ${res.status}`);
    const data = await res.json();
    render(data.route);
  } catch (_) {
    // Network/parse failure while authenticated -> show the load fallback.
    ops.showFallback();
  }
}

function logout() {
  clearToken();
  showLogin();
}

// --- Today's summary ---------------------------------------------------------
function metric(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "summary-metric";
  const v = document.createElement("div");
  v.className = "summary-value";
  v.textContent = String(value);
  const l = document.createElement("div");
  l.className = "summary-label";
  l.textContent = label;
  wrap.appendChild(v);
  wrap.appendChild(l);
  return wrap;
}

async function loadSummary() {
  summaryContent.innerHTML = "";
  try {
    const res = await fetch("/api/driver/summary", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`summary request failed: ${res.status}`);
    const data = await res.json();
    if (data.completed === 0) {
      const p = document.createElement("p");
      p.className = "message";
      p.textContent = "No deliveries completed yet today.";
      summaryContent.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    frag.appendChild(metric("Completed", data.completed));
    frag.appendChild(metric("On time", `${data.onTimePct}%`));
    frag.appendChild(metric("Early", data.early));
    frag.appendChild(metric("Late", data.late));
    summaryContent.appendChild(frag);
  } catch (_) {
    const p = document.createElement("p");
    p.className = "message";
    p.textContent = "Could not load today's summary.";
    summaryContent.appendChild(p);
  }
}

function toggleSummary() {
  const willShow = summaryPanel.hidden;
  summaryPanel.hidden = !willShow;
  if (willShow) loadSummary();
}

// --- Boot -------------------------------------------------------------------
function init() {
  loginForm.addEventListener("submit", handleLogin);
  logoutBtn.addEventListener("click", logout);
  summaryBtn.addEventListener("click", toggleSummary);

  const stored = getStoredToken();
  if (stored) {
    token = stored;
    showRouteView();
    progress.start();
    // loadRoute() handles its own errors (never rejects), so finish the bar
    // once it settles regardless of outcome.
    loadRoute().finally(() => progress.done());
  } else {
    showLogin();
  }
}

init();
