/* Farmhouse Route Optimization — dashboard client.
 *
 * The dashboard has two data sources, switched with the topbar toggle:
 *
 *   • "History" (default) — POST /api/history/compare. Visualizes the ORIGINAL
 *     delivery order (from the History workbook's TIME_VISIT) against a freshly
 *     AI-optimized order for the same customers: two routes on the map, the
 *     distance / CO₂ saving as metric cards, and a per-customer sequence diff in
 *     the sidebar. This is the history-based optimizer view.
 *   • "Sample plan" — GET /api/plan/sample. The original multi-vehicle sample
 *     scenario (kept so the fleet-packing demo is still one click away).
 *
 * View shaping for the History source is delegated to the pure `planView.js`
 * module (shared with the planner page); this file is only the DOM + Leaflet +
 * fetch wiring. All server-provided text (customer names) is written with
 * textContent / DOM APIs — never innerHTML — so untrusted content cannot inject
 * markup.
 */

import { summarizeComparison, fmtEta, buildFilters } from "./planView.js";
import * as progress from "./progress.js";
import { adminAuthHeader, ensureAdmin, handledUnauthorized } from "./adminAuth.js";
import { wireCascadingFilters, populateSelect } from "./filterOptions.js";

const ROUTE_COLORS = [
  "#ffb703",
  "#2dd4a7",
  "#4cc9f0",
  "#f72585",
  "#b5179e",
  "#90be6d",
];

// Colors for the two history orderings.
const HIST_COLOR = "#f4795b"; // original (historical) order
const OPT_COLOR = "#2dd4a7"; // AI-optimized order

let map;
let layerGroup;
let currentSource = "history";

// ---------------------------------------------------------------------------
// Small safe-DOM helpers (text always via textContent)
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function setChildren(container, nodes) {
  container.textContent = "";
  for (const n of nodes) if (n) container.appendChild(n);
}

/** Read a form's named inputs + selects into a raw `{ name: value }` map. */
function readFormInputs(form) {
  const inputs = {};
  for (const field of form.querySelectorAll("input[name], select[name]")) {
    inputs[field.name] = field.value;
  }
  return inputs;
}

/** Current History filter criteria, trimmed + empties dropped. The single
 * "Day" select (see wireHistoryDayFilter) maps to BOTH deliveryDateFrom and
 * deliveryDateTo — routes are calculated per store PER DAY, so the filter
 * only ever offers one day at a time rather than an open date range. */
function currentHistoryFilters() {
  const form = document.getElementById("historyFilters");
  const raw = readFormInputs(form);
  const day = raw.Day;
  delete raw.Day;
  if (day) {
    raw.deliveryDateFrom = day;
    raw.deliveryDateTo = day;
  }
  return buildFilters(raw);
}

// ---------------------------------------------------------------------------
// Day picker (History filter bar) — GET /api/history/dates, scoped by the
// OTHER active categorical filters and refreshed whenever one of them
// changes, so it only ever offers days that actually have data for the
// current DC/Store/etc. selection (never an arbitrary open range).
// ---------------------------------------------------------------------------

const HISTORY_CATEGORICAL_FIELDS = ["DC_Name", "StoreName", "StoreGroup", "Store Area", "CustomerType"];

function currentCategoricalFilters(form) {
  const out = {};
  for (const name of HISTORY_CATEGORICAL_FIELDS) {
    const field = form.elements[name];
    if (field && field.value) out[name] = field.value;
  }
  return out;
}

async function fetchHistoryDates(activeFilters) {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(activeFilters)) {
      if (typeof value === "string" && value.trim() !== "") params.set(key, value);
    }
    const qs = params.toString();
    const res = await fetch(`/api/history/dates${qs ? `?${qs}` : ""}`, {
      headers: { ...adminAuthHeader() },
    });
    if (handledUnauthorized(res)) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.dates) ? data.dates : [];
  } catch (_) {
    return null;
  }
}

async function refreshHistoryDaySelect() {
  const form = document.getElementById("historyFilters");
  const daySelect = form.elements["Day"];
  const dates = await fetchHistoryDates(currentCategoricalFilters(form));
  if (dates) populateSelect(daySelect, dates);
}

/** Wire the Day select to refresh (scoped by the other filters) whenever any
 * of them changes, plus an initial unfiltered populate. */
function wireHistoryDayFilter(form) {
  for (const name of HISTORY_CATEGORICAL_FIELDS) {
    const field = form.elements[name];
    if (field) field.addEventListener("change", refreshHistoryDaySelect);
  }
  refreshHistoryDaySelect();
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  map = L.map("map").setView([13.7563, 100.5018], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);
}

function depotMarker(depot, bounds) {
  if (!depot) return;
  L.marker([depot.lat, depot.lng], { title: "Depot" })
    .bindPopup(`<b>Depot</b><br>${depot.name || depot.id || "Distribution Center"}`)
    .addTo(layerGroup);
  bounds.push([depot.lat, depot.lng]);
}

function fitBounds(bounds) {
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
}

// ---------------------------------------------------------------------------
// Metric cards (shared renderer)
// ---------------------------------------------------------------------------

function renderMetricCards(cards) {
  const nodes = cards.map((c) => {
    const card = el("div", "metric-card");
    card.appendChild(el("div", "label", c.label));
    card.appendChild(el("div", "value", c.value));
    if (c.sub) card.appendChild(el("div", "sub", c.sub));
    return card;
  });
  setChildren(document.getElementById("metrics"), nodes);
}

// ===========================================================================
// History source (default)
// ===========================================================================

async function loadHistory() {
  const res = await fetch("/api/history/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminAuthHeader() },
    body: JSON.stringify({ filters: currentHistoryFilters() }),
  });
  if (handledUnauthorized(res)) return;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);

  const vm = summarizeComparison(data);
  if (vm.isMessage) {
    await renderHistoryMessage(vm.message);
    return;
  }
  renderHistoryMetrics(vm);
  renderHistoryMap(vm);
  renderHistorySidebar(vm);
}

/** Fetch the DC/StoreName breakdown, or `null` when unavailable (network
 * error, non-2xx, or a 401 — which also triggers a redirect to login). */
async function fetchHistoryOverview() {
  try {
    const res = await fetch("/api/history/overview", { headers: { ...adminAuthHeader() } });
    if (handledUnauthorized(res)) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * A labeled dropdown of overview rows. Picking one sets the matching field on
 * the History filter form and re-runs the comparison, so the overview acts as
 * a "browse in" shortcut on top of the existing filter machinery.
 */
function overviewSelect(label, rows, valueKey, formatOption, filterFieldName) {
  const wrap = el("div", "overview-field");
  const labelEl = el("label", null, label);

  const select = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `(choose a ${label.toLowerCase()})`;
  select.appendChild(placeholder);
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = row[valueKey];
    opt.textContent = formatOption(row);
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    if (!select.value) return;
    const form = document.getElementById("historyFilters");
    const field = form.elements[filterFieldName];
    field.value = select.value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    currentSource = "history";
    optimize();
  });

  labelEl.appendChild(select);
  wrap.appendChild(labelEl);
  return wrap;
}

/** "Browse by DC" / "browse by store" dropdowns built from the overview
 * counts; `null` when there is nothing to show (e.g. no History uploaded). */
function renderOverviewPanel(overview) {
  if (!overview || (overview.byDc.length === 0 && overview.byStore.length === 0)) {
    return null;
  }

  const panel = el("div", "overview-panel");
  panel.appendChild(el("div", "section-title", "Overview — browse by DC or store"));

  if (overview.byDc.length > 0) {
    panel.appendChild(
      overviewSelect(
        "DC",
        overview.byDc,
        "dcName",
        (row) => `${row.dcName} — ${row.customers} customers, ${row.visits} visits`,
        "DC_Name",
      ),
    );
  }

  if (overview.byStore.length > 0) {
    panel.appendChild(
      overviewSelect(
        "Store",
        overview.byStore,
        "storeName",
        (row) => `${row.storeName} — ${row.customers} customers, ${row.visits} visits`,
        "StoreName",
      ),
    );
  }

  return panel;
}

async function renderHistoryMessage(message) {
  renderMetricCards([]);
  layerGroup.clearLayers();

  const box = el("div", "message-box", message);
  const hint = el(
    "p",
    "hint",
    "Apply a filter above to compare a route-sized set of customers, or upload the " +
      "History and Shop_Master workbooks on the planner page (a customer needs a " +
      "matching, resolvable Shop_Master row to be routable).",
  );
  const link = el("a", "btn secondary", "Go to route planner input");
  link.href = "plan.html";

  const overviewPanel = renderOverviewPanel(await fetchHistoryOverview());
  setChildren(
    document.getElementById("routes"),
    [box, hint, link, overviewPanel].filter(Boolean),
  );
}

function renderHistoryMetrics(vm) {
  renderMetricCards([
    { label: "Customers", value: String(vm.rows.length) },
    {
      label: "Historical distance",
      value: `${vm.historicalDistanceKm} km`,
      sub: "original TIME_VISIT order",
    },
    {
      label: "Optimized distance",
      value: `${vm.optimizedDistanceKm} km`,
      sub: `−${vm.savedKm} km (${vm.savedPct}%) vs historical`,
    },
    {
      label: "CO₂ emissions",
      value: `${vm.optimizedCo2Kg} kg`,
      sub: `−${vm.co2SavedKg} kg saved`,
    },
  ]);
}

function orderedLatLngs(rows, seqKey, depot) {
  const stops = rows
    .filter((r) => r.location)
    .slice()
    .sort((a, b) => a[seqKey] - b[seqKey])
    .map((r) => [r.location.lat, r.location.lng]);
  if (!depot || stops.length === 0) return stops;
  return [[depot.lat, depot.lng], ...stops, [depot.lat, depot.lng]];
}

function renderHistoryMap(vm) {
  layerGroup.clearLayers();
  const bounds = [];
  depotMarker(vm.depot, bounds);

  // Historical route: dashed amber. Optimized route: solid green.
  const histLine = orderedLatLngs(vm.rows, "historicalSeq", vm.depot);
  const optLine = orderedLatLngs(vm.rows, "optimizedSeq", vm.depot);

  if (histLine.length > 1) {
    L.polyline(histLine, {
      color: HIST_COLOR,
      weight: 3,
      opacity: 0.7,
      dashArray: "6 8",
    }).addTo(layerGroup);
  }
  if (optLine.length > 1) {
    L.polyline(optLine, { color: OPT_COLOR, weight: 3, opacity: 0.9 }).addTo(layerGroup);
  }

  // One marker per customer, labelled with its optimized position.
  for (const r of vm.rows) {
    if (!r.location) continue;
    const { lat, lng } = r.location;
    bounds.push([lat, lng]);
    L.circleMarker([lat, lng], {
      radius: 8,
      color: OPT_COLOR,
      fillColor: OPT_COLOR,
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindPopup(
        `<b>${escapeHtml(r.customer || r.customerCode || "Customer")}</b><br>` +
          `Historical #${r.historicalSeq} · ETA ${fmtEta(r.historicalEta)}<br>` +
          `Optimized #${r.optimizedSeq} · ETA ${fmtEta(r.optimizedEta)}`,
      )
      .addTo(layerGroup);
  }

  fitBounds(bounds);
}

function renderHistorySidebar(vm) {
  const nodes = [];

  // Legend explaining the two routes.
  const legend = el("div", "legend");
  legend.appendChild(legendItem(HIST_COLOR, "Historical order", true));
  legend.appendChild(legendItem(OPT_COLOR, "AI-optimized order", false));
  nodes.push(legend);

  // Per-customer sequence diff, listed in the optimized order.
  const list = el("ul", "stop-list");
  const ordered = vm.rows.slice().sort((a, b) => a.optimizedSeq - b.optimizedSeq);
  for (const r of ordered) {
    const li = el("li");
    li.appendChild(el("span", "seq", r.optimizedSeq));

    const info = el("div", "stop-info");
    info.appendChild(el("div", "name", r.customer || r.customerCode || "—"));

    const moved = r.historicalSeq - r.optimizedSeq;
    const move =
      moved === 0 ? "unchanged" : moved > 0 ? `▲ up ${moved}` : `▼ down ${-moved}`;
    info.appendChild(
      el(
        "div",
        "eta",
        `was #${r.historicalSeq} (${move}) · ETA ${fmtEta(r.historicalEta)} → ${fmtEta(r.optimizedEta)}`,
      ),
    );
    li.appendChild(info);
    list.appendChild(li);
  }
  nodes.push(list);

  setChildren(document.getElementById("routes"), nodes);
}

function legendItem(color, label, dashed) {
  const item = el("div", "legend-item");
  const sw = el("span", "line-swatch");
  sw.style.background = dashed
    ? `repeating-linear-gradient(90deg, ${color} 0 6px, transparent 6px 12px)`
    : color;
  item.appendChild(sw);
  item.appendChild(el("span", null, label));
  return item;
}

// ===========================================================================
// Sample-plan source (original multi-vehicle demo)
// ===========================================================================

async function loadSample() {
  const res = await fetch("/api/plan/sample", { headers: { ...adminAuthHeader() } });
  if (handledUnauthorized(res)) return;
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const plan = await res.json();
  renderSampleMetrics(plan.metrics);
  renderSampleMap(plan);
  renderSampleRoutes(plan);
}

function renderSampleMetrics(m) {
  renderMetricCards([
    { label: "Orders served", value: `${m.ordersServed}/${m.totalOrders}` },
    { label: "Vehicles used", value: `${m.vehiclesUsed}/${m.fleetSize}` },
    {
      label: "Total distance",
      value: `${m.optimizedDistanceKm} km`,
      sub: `−${m.distanceSavedKm} km (${m.distanceSavedPct}%) vs baseline`,
    },
    {
      label: "CO₂ emissions",
      value: `${m.optimizedCo2Kg} kg`,
      sub: `−${m.co2SavedKg} kg (${m.co2SavedPct}%) saved`,
    },
  ]);
}

function renderSampleMap(plan) {
  layerGroup.clearLayers();
  const bounds = [];
  depotMarker(plan.depot, bounds);

  plan.routes.forEach((route, idx) => {
    if (route.stops.length === 0) return;
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const line = [[plan.depot.lat, plan.depot.lng]];

    route.stops.forEach((stop) => {
      const { lat, lng } = stop.location;
      line.push([lat, lng]);
      bounds.push([lat, lng]);

      L.circleMarker([lat, lng], {
        radius: 8,
        color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindPopup(
          `<b>${stop.sequence}. ${escapeHtml(stop.customer)}</b><br>` +
            `${escapeHtml(route.vehicleId)} · ETA ${fmtEta(stop.eta)}<br>` +
            `Demand: ${stop.demand} units`,
        )
        .addTo(layerGroup);
    });

    line.push([plan.depot.lat, plan.depot.lng]);
    L.polyline(line, { color, weight: 3, opacity: 0.8 }).addTo(layerGroup);
  });

  fitBounds(bounds);
}

function renderSampleRoutes(plan) {
  const active = plan.routes.filter((r) => r.stops.length > 0);
  const nodes = active.map((route, idx) => {
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const isEv = route.fuelType === "ev";

    const card = el("div", "route-card");

    const head = el("div", "route-head");
    const veh = el("div", "veh");
    const sw = el("span", "swatch");
    sw.style.background = color;
    veh.appendChild(sw);
    veh.appendChild(el("span", null, route.vehicleId));
    head.appendChild(veh);
    head.appendChild(el("span", `tag ${isEv ? "ev" : ""}`, route.fuelType));
    card.appendChild(head);

    card.appendChild(
      el(
        "div",
        "route-meta",
        `${route.stops.length} stops · ${route.distanceKm} km · ` +
          `${route.co2Kg} kg CO₂ · load ${route.load}/${route.capacity}`,
      ),
    );

    const list = el("ul", "stop-list");
    for (const s of route.stops) {
      const li = el("li");
      li.appendChild(el("span", "seq", s.sequence));
      const info = el("div", "stop-info");
      info.appendChild(el("div", "name", s.customer));
      info.appendChild(
        el("div", "eta", `ETA ${fmtEta(s.eta)} · ${s.demand} units · ${s.cumulativeKm} km`),
      );
      li.appendChild(info);
      list.appendChild(li);
    }
    card.appendChild(list);
    return card;
  });

  if (plan.unassignedOrders.length > 0) {
    nodes.push(
      el(
        "p",
        "hint",
        `Unassigned (over capacity): ${plan.unassignedOrders.map((o) => o.orderId).join(", ")}`,
      ),
    );
  }

  if (nodes.length === 0) nodes.push(el("p", "hint", "No routes generated."));
  setChildren(document.getElementById("routes"), nodes);
}

// ---------------------------------------------------------------------------
// Leaflet popups use innerHTML; escape the few interpolated text values.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

// ---------------------------------------------------------------------------
// Orchestration + toggle wiring
// ---------------------------------------------------------------------------

async function optimize() {
  const btn = document.getElementById("optimizeBtn");
  btn.disabled = true;
  btn.textContent = "Optimizing…";
  progress.start();
  try {
    if (currentSource === "sample") {
      await loadSample();
    } else {
      await loadHistory();
    }
    progress.done();
  } catch (err) {
    progress.fail();
    setChildren(document.getElementById("routes"), [
      el("p", "hint", `Failed to load: ${err.message}`),
    ]);
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-optimize";
  }
}

/** The filter bar only applies to the History source, so hide it otherwise. */
function updateFilterVisibility() {
  document.getElementById("historyFilters").hidden = currentSource !== "history";
}

function wireToggle() {
  const toggle = document.getElementById("sourceToggle");
  toggle.addEventListener("click", (event) => {
    const seg = event.target.closest(".seg");
    if (!seg) return;
    const source = seg.dataset.source;
    if (source === currentSource) return;

    currentSource = source;
    for (const s of toggle.querySelectorAll(".seg")) {
      const active = s === seg;
      s.classList.toggle("active", active);
      s.setAttribute("aria-selected", active ? "true" : "false");
    }
    updateFilterVisibility();
    optimize();
  });
}

function wireFilters() {
  const form = document.getElementById("historyFilters");
  // Applying filters re-runs the History comparison.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    currentSource = "history";
    optimize();
  });
  document.getElementById("clearFilters").addEventListener("click", () => {
    form.reset();
    currentSource = "history";
    optimize();
  });
}

// The dashboard is admin-gated: require a token before booting (otherwise the
// data endpoints would 401). ensureAdmin() redirects to the login page.
if (ensureAdmin()) {
  initMap();
  wireToggle();
  wireFilters();
  updateFilterVisibility();
  document.getElementById("optimizeBtn").addEventListener("click", optimize);
  // Populate the categorical filter dropdowns from the uploaded history data,
  // cascading each dropdown's options by whatever is already selected.
  wireCascadingFilters(document.getElementById("historyFilters"));
  // Day picker: only offers days that have data for the current selection.
  wireHistoryDayFilter(document.getElementById("historyFilters"));
  optimize();
}
