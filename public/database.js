/* Farmhouse Database viewer — summary + paginated raw-row browser for the
 * shops, history_entries and presale_entries tables.
 *
 * All requests send `Authorization: Bearer <token>`; a 401 redirects to the
 * admin login page (ensureAdmin / handledUnauthorized). Server-provided text
 * (customer names, shop names, etc.) is rendered with textContent / DOM APIs
 * — never innerHTML — so it cannot inject markup.
 */

import { adminAuthHeader, ensureAdmin, handledUnauthorized } from "./adminAuth.js";

const PAGE_SIZE = 50;

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

// --- Fetch helpers -----------------------------------------------------------
async function apiGet(url) {
  try {
    const res = await fetch(url, { headers: { ...adminAuthHeader() } });
    if (handledUnauthorized(res)) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

// --- Summary -----------------------------------------------------------------
function metricCard(label, value, sub) {
  const card = el("div", "metric-card");
  card.appendChild(el("div", "label", label));
  card.appendChild(el("div", "value", value));
  if (sub) card.appendChild(el("div", "sub", sub));
  return card;
}

function renderSummary(summary) {
  if (!summary) {
    setChildren(document.getElementById("summaryMetrics"), [
      el("p", "hint", "Could not load summary."),
    ]);
    return;
  }

  setChildren(document.getElementById("summaryMetrics"), [
    metricCard("Shops", summary.shops.total, `${summary.shops.resolved} resolved · ${summary.shops.unresolved} unresolved`),
    metricCard("History rows", summary.history.total, `${summary.history.distinctCustomers} distinct customers`),
    metricCard("Presale rows", summary.presale.total, `${summary.presale.distinctCustomers} distinct customers`),
  ]);

  setChildren(document.getElementById("byDcTable"), [
    buildTable(
      ["DC", "Customers", "Visits"],
      summary.byDc,
      [(r) => r.dcName, (r) => r.customers, (r) => r.visits],
    ),
  ]);

  setChildren(document.getElementById("byStoreTable"), [
    buildTable(
      ["Store", "DC", "Customers", "Visits"],
      summary.byStore,
      [(r) => r.storeName, (r) => r.dcName, (r) => r.customers, (r) => r.visits],
    ),
  ]);
}

// --- Paginated raw-row browsers ----------------------------------------------
/**
 * Wire one paginated table: `endpoint` returns `{ rows, total, page, pageSize }`.
 * `renderTable(rows)` builds the table node; `renderPager` is generated here.
 */
function createPager(endpoint, tableContainerId, pagerContainerId, columns) {
  let page = 1;
  const tableContainer = document.getElementById(tableContainerId);
  const pagerContainer = document.getElementById(pagerContainerId);

  async function load() {
    const data = await apiGet(`${endpoint}?page=${page}&pageSize=${PAGE_SIZE}`);
    if (!data) {
      setChildren(tableContainer, [el("p", "hint", "Could not load data.")]);
      return;
    }
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    setChildren(
      tableContainer,
      [buildTable(columns.headers, data.rows, columns.keyFns)],
    );
    renderPager(data.total, totalPages);
  }

  function renderPager(total, totalPages) {
    const prevBtn = el("button", "btn secondary small", "Prev");
    prevBtn.type = "button";
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener("click", () => {
      if (page > 1) {
        page -= 1;
        load();
      }
    });

    const nextBtn = el("button", "btn secondary small", "Next");
    nextBtn.type = "button";
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener("click", () => {
      if (page < totalPages) {
        page += 1;
        load();
      }
    });

    setChildren(pagerContainer, [
      el("span", null, `${total} row(s) · page ${page}/${totalPages}`),
      prevBtn,
      nextBtn,
    ]);
  }

  return { load, reset: () => { page = 1; return load(); } };
}

const shopsPager = createPager("/api/database/shops", "shopsTable", "shopsPager", {
  headers: ["Customer code", "Shop name", "Lat", "Lng", "Source", "Service (min)", "Open", "Close"],
  keyFns: [
    (r) => r.customerCode,
    (r) => r.shopName,
    (r) => (r.lat != null ? r.lat.toFixed(5) : null),
    (r) => (r.lng != null ? r.lng.toFixed(5) : null),
    (r) => sourceCell(r.coordSource),
    (r) => r.serviceTimeMin,
    (r) => r.openTime,
    (r) => r.closeTime,
  ],
});

function sourceCell(source) {
  const resolved = source === "master" || source === "geocoded" || source === "longdo";
  return el("span", resolved ? "resolved-yes" : "resolved-no", source ?? "—");
}

const historyPager = createPager("/api/database/history", "historyTable", "historyPager", {
  headers: ["Customer code", "Customer name", "DC", "Store", "Date", "Time visit", "Qty"],
  keyFns: [
    (r) => r.customerCode,
    (r) => r.customerName,
    (r) => r.dcName,
    (r) => r.storeName,
    (r) => fmtDate(r.invoiceDate),
    (r) => r.timeVisit,
    (r) => r.quantity,
  ],
});

const presalePager = createPager("/api/database/presale", "presaleTable", "presalePager", {
  headers: ["Customer code", "Customer name", "Delivery date", "Demand", "DC", "Store"],
  keyFns: [
    (r) => r.customerCode,
    (r) => r.customerName,
    (r) => fmtDate(r.deliveryDate),
    (r) => r.demand,
    (r) => r.dcName,
    (r) => r.storeName,
  ],
});

/** Server-provided dates come through JSON as ISO strings; show just the date part. */
function fmtDate(value) {
  if (!value) return null;
  const s = String(value);
  return s.slice(0, 10);
}

// --- Boot ---------------------------------------------------------------------
async function loadAll() {
  const summary = await apiGet("/api/database/summary");
  renderSummary(summary);
  await Promise.all([shopsPager.reset(), historyPager.reset(), presalePager.reset()]);
}

document.getElementById("refreshBtn").addEventListener("click", loadAll);

if (ensureAdmin()) {
  loadAll();
}
