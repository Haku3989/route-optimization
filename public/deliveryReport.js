/* Farmhouse Daily Delivery Report — admin dashboard client.
 *
 * POSTs the current filter selection (a single Day, plus optional
 * DC_Name/StoreName/StoreGroup/Store Area/CustomerType) to
 * POST /api/delivery-report/compute and renders the resulting summary
 * (metric cards + by-store table), detail (per-delivery rows), and
 * excluded/skipped panels.
 *
 * All requests send `Authorization: Bearer <token>`; a 401 redirects to the
 * admin login page (ensureAdmin / handledUnauthorized). Server-provided text
 * is rendered with textContent / DOM APIs — never innerHTML.
 */

import { buildFilters, fmtEta } from "./planView.js";
import { summarizeDeliveryReport } from "./deliveryReportView.js";
import { adminAuthHeader, ensureAdmin, handledUnauthorized } from "./adminAuth.js";
import { wireCascadingFilters, populateSelect } from "./filterOptions.js";

// --- Small safe-DOM helpers -------------------------------------------------
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

function buildTable(headers, rows, keyFns) {
  const wrap = el("div", "db-table-wrap");
  const table = el("table", "data");
  const thead = el("thead");
  const htr = el("tr");
  for (const h of headers) htr.appendChild(el("th", null, h));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  if (rows.length === 0) {
    const tr = el("tr");
    const td = el("td", "hint", "No rows.");
    td.colSpan = headers.length;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of rows) {
      const tr = el("tr");
      for (const keyFn of keyFns) {
        const value = keyFn(row);
        tr.appendChild(value instanceof Node ? wrapCell(value) : el("td", null, value ?? "—"));
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function wrapCell(node) {
  const td = el("td");
  td.appendChild(node);
  return td;
}

function metricCard(label, value, sub) {
  const card = el("div", "metric-card");
  card.appendChild(el("div", "label", label));
  card.appendChild(el("div", "value", value));
  if (sub) card.appendChild(el("div", "sub", sub));
  return card;
}

function categoryCell(category) {
  const cls = category === "early" ? "status-early" : category === "late" ? "status-late" : "status-on-time";
  const text = category === "early" ? "Early" : category === "late" ? "Late" : category === "on_time" ? "On time" : "—";
  return el("span", cls, text);
}

// ---------------------------------------------------------------------------
// Day picker — GET /api/history/dates, scoped by the other active categorical
// filters (same convention as the dashboard's History day-picker).
// ---------------------------------------------------------------------------

const CATEGORICAL_FIELDS = ["DC_Name", "StoreName", "StoreGroup", "Store Area", "CustomerType"];

function currentCategoricalFilters(form) {
  const out = {};
  for (const name of CATEGORICAL_FIELDS) {
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

async function refreshDaySelect() {
  const form = document.getElementById("reportFilters");
  const daySelect = form.elements["Day"];
  const dates = await fetchHistoryDates(currentCategoricalFilters(form));
  if (dates) populateSelect(daySelect, dates);
}

function wireDayFilter(form) {
  for (const name of CATEGORICAL_FIELDS) {
    const field = form.elements[name];
    if (field) field.addEventListener("change", refreshDaySelect);
  }
  refreshDaySelect();
}

// ---------------------------------------------------------------------------
// Filters -> request body
// ---------------------------------------------------------------------------

function readFormInputs(form) {
  const inputs = {};
  for (const field of form.querySelectorAll("input[name], select[name]")) {
    inputs[field.name] = field.value;
  }
  return inputs;
}

function currentReportFilters() {
  const form = document.getElementById("reportFilters");
  const raw = readFormInputs(form);
  const day = raw.Day;
  delete raw.Day;
  const filters = buildFilters(raw);
  if (day) {
    filters.deliveryDateFrom = day;
    filters.deliveryDateTo = day;
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showPanel(id, visible) {
  document.getElementById(id).hidden = !visible;
}

function renderMessage(message) {
  showPanel("messagePanel", true);
  showPanel("summaryPanel", false);
  showPanel("detailPanel", false);
  showPanel("excludedPanel", false);
  document.getElementById("messageText").textContent = message;
}

function renderReport(vm) {
  showPanel("messagePanel", false);
  showPanel("summaryPanel", true);
  showPanel("detailPanel", true);
  showPanel("excludedPanel", true);

  document.getElementById("summaryDay").textContent = vm.day ?? "";
  document.getElementById("toleranceHint").textContent =
    vm.toleranceMin != null
      ? `On time = within ±${vm.toleranceMin} min of the AI-optimized ETA.`
      : "";

  const totals = vm.totals ?? {
    routableDeliveries: 0,
    unroutableCount: 0,
    unparseableTimeCount: 0,
    early: 0,
    onTime: 0,
    late: 0,
    earlyPct: 0,
    onTimePct: 0,
    latePct: 0,
    avgDeviationMin: null,
  };

  setChildren(document.getElementById("summaryMetrics"), [
    metricCard("Deliveries evaluated", totals.routableDeliveries, `${totals.unroutableCount} excluded (no coordinates)`),
    metricCard("On time", `${totals.onTimePct}%`, `${totals.onTime} of ${totals.routableDeliveries}`),
    metricCard("Early", `${totals.earlyPct}%`, `${totals.early} of ${totals.routableDeliveries}`),
    metricCard("Late", `${totals.latePct}%`, `${totals.late} of ${totals.routableDeliveries}`),
    metricCard("Avg deviation", totals.avgDeviationMin != null ? `${totals.avgDeviationMin} min` : "—"),
  ]);

  setChildren(document.getElementById("byStoreTable"), [
    buildTable(
      ["Store", "DC", "Deliveries", "Early", "On time", "Late", "On-time %", "Avg dev (min)"],
      vm.stores,
      [
        (r) => r.storeName,
        (r) => r.dcName,
        (r) => r.routableDeliveries,
        (r) => r.early,
        (r) => r.onTime,
        (r) => r.late,
        (r) => `${r.onTimePct}%`,
        (r) => (r.avgDeviationMin != null ? r.avgDeviationMin : "—"),
      ]
    ),
  ]);

  const hasSkipped = vm.skippedStores.length > 0;
  showPanel("skippedHeader", hasSkipped);
  setChildren(
    document.getElementById("skippedStoresTable"),
    hasSkipped
      ? [
          buildTable(
            ["Store", "DC", "Records", "Reason"],
            vm.skippedStores,
            [(r) => r.storeName, (r) => r.dcName, (r) => r.recordCount, (r) => r.reason]
          ),
        ]
      : []
  );

  setChildren(document.getElementById("detailTable"), [
    buildTable(
      ["Store", "Customer", "Actual", "Optimized ETA", "Deviation (min)", "Status"],
      vm.rows,
      [
        (r) => r.storeName,
        (r) => r.customer ?? r.customerCode,
        (r) => fmtEta(r.actualEta),
        (r) => fmtEta(r.optimizedEta),
        (r) => r.deviationMin,
        (r) => categoryCell(r.category),
      ]
    ),
  ]);

  setChildren(document.getElementById("excludedTable"), [
    buildTable(
      ["Store", "Customer", "Reason"],
      vm.excluded,
      [(r) => r.storeName, (r) => r.customer ?? r.customerCode, (r) => r.reason]
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function runReport() {
  const filters = currentReportFilters();
  if (!filters.deliveryDateFrom) {
    renderMessage("Choose a day to run the report.");
    return;
  }

  try {
    const res = await fetch("/api/delivery-report/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminAuthHeader() },
      body: JSON.stringify({ filters }),
    });
    if (handledUnauthorized(res)) return;
    const data = await res.json();
    const vm = summarizeDeliveryReport(data);
    if (vm.isMessage) {
      renderMessage(vm.message);
    } else {
      renderReport(vm);
    }
  } catch (_) {
    renderMessage("Could not load the report.");
  }
}

const form = document.getElementById("reportFilters");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  runReport();
});
document.getElementById("clearFilters").addEventListener("click", () => {
  form.reset();
  renderMessage("Choose a day to run the report.");
});

if (ensureAdmin()) {
  wireCascadingFilters(form);
  wireDayFilter(form);
  renderMessage("Choose a day to run the report.");
}
