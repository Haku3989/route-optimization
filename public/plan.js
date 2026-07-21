/* Farmhouse Route Planner — input page controller.
 *
 * This is the DOM/network layer for the planner input page. ALL testable view
 * logic lives in the pure `planView.js` module (imported below); this file only
 * wires that logic to the DOM and `fetch`.
 *
 * SECURITY NOTE: the three endpoints this page calls — POST /api/ingest/upload,
 * POST /api/history/compare and POST /api/presale/plan — are UNAUTHENTICATED by
 * design in this prototype (see the matching notes in the route modules). This
 * page adds NO auth; authentication must be added before any non-prototype
 * deployment.
 *
 * XSS: every value that comes back from the server (customer names, reasons,
 * warning text, headers, etc.) is written with textContent / DOM APIs — never
 * interpolated into innerHTML — so untrusted content is always treated as text
 * and cannot inject markup (mirrors the driver.js buildStopEl pattern).
 */

import {
  buildFilters,
  fmtEta,
  summarizeComparison,
  summarizePlan,
} from "./planView.js";
import * as progress from "./progress.js";
import {
  adminAuthHeader,
  getAdminToken,
  ensureAdmin,
  handledUnauthorized,
  redirectToLogin,
} from "./adminAuth.js";
import {
  fetchFilterOptions,
  populateFilterForm,
  populateSelect,
  wireCascadingFilters,
} from "./filterOptions.js";

// The planner is admin-gated: without a token the ingest/history/presale
// endpoints return 401, so send the user to sign in before showing the page.
ensureAdmin();

// ---------------------------------------------------------------------------
// Small DOM helpers (safe by construction — text goes in via textContent)
// ---------------------------------------------------------------------------

/** Create an element with an optional class and text content. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/** Replace all children of `container` with `node` (or nothing). */
function setContent(container, node) {
  container.textContent = "";
  if (node) container.appendChild(node);
  container.hidden = false;
}

/** Build a table from a header list + row objects, reading cells via keys. */
function buildTable(headers, rows, keyFns) {
  const table = el("table", "data");
  const thead = el("thead");
  const htr = el("tr");
  for (const h of headers) htr.appendChild(el("th", null, h));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const fn of keyFns) {
      const value = fn(row);
      tr.appendChild(el("td", null, value == null ? "—" : value));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** A dimmed "message" box for the { message } guard responses. */
function messageBox(message) {
  return el("div", "message-box", message);
}

/** A red error box for 4xx responses. */
function errorBox(message) {
  return el("div", "error-box", message);
}

// ---------------------------------------------------------------------------
// 1 · Upload
// ---------------------------------------------------------------------------

const uploadForm = document.getElementById("uploadForm");
const uploadType = document.getElementById("uploadType");
const uploadFile = document.getElementById("uploadFile");
const uploadBtn = document.getElementById("uploadBtn");
const uploadResult = document.getElementById("uploadResult");
const uploadLog = document.getElementById("uploadLog");

let uploadCount = 0;

function renderUploadSuccess(data) {
  const frag = document.createDocumentFragment();

  const summary = el("div", "summary-line");
  summary.appendChild(stat("Detected type", data.type));
  summary.appendChild(stat("Rows", data.rowCount));
  summary.appendChild(stat("Mapped", data.mapped));
  frag.appendChild(summary);

  // Headers as chips.
  if (Array.isArray(data.headers) && data.headers.length > 0) {
    frag.appendChild(el("div", "section-title", "Headers"));
    const chips = el("div", "chips");
    for (const h of data.headers) chips.appendChild(el("span", "chip", h));
    frag.appendChild(chips);
  }

  // Warnings: collapsed by default (a large upload can produce thousands of
  // rows), with a toggle to reveal them and a "Show more" button to page
  // through the list instead of rendering it all at once.
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.length > 0) {
    frag.appendChild(buildWarningsSection(warnings));
  } else {
    frag.appendChild(el("p", "hint", "No warnings."));
  }

  setContent(uploadResult, frag);
}

/** Number of warning rows revealed per "Show more" click. */
const WARNINGS_PAGE_SIZE = 20;

/**
 * Build the collapsible warnings section: a header with a count + toggle
 * button, and (once expanded) a table that starts at `WARNINGS_PAGE_SIZE` rows
 * and grows via a "Show more" button until every warning is shown.
 */
function buildWarningsSection(warnings) {
  const section = el("div", "warnings-section");

  const header = el("div", "warnings-header");
  header.appendChild(el("span", "section-title warn-title", `Warnings (${warnings.length})`));
  const toggleBtn = el("button", "btn secondary small", "Show details");
  toggleBtn.type = "button";
  header.appendChild(toggleBtn);
  section.appendChild(header);

  const body = el("div", "warnings-body");
  body.hidden = true;
  section.appendChild(body);

  let renderedCount = 0;
  const tableHolder = el("div");
  const showMoreBtn = el("button", "btn secondary small", "Show more");
  showMoreBtn.type = "button";

  function renderMore() {
    const next = warnings.slice(renderedCount, renderedCount + WARNINGS_PAGE_SIZE);
    renderedCount += next.length;

    // Rebuild the table with every row rendered so far (simplest correct
    // approach — the DOM helper builds a full <table> from a row list).
    setContent(
      tableHolder,
      buildTable(
        ["row / id", "reason"],
        warnings.slice(0, renderedCount),
        [(w) => (w.id != null ? w.id : w.row != null ? w.row : "—"), (w) => w.reason],
      ),
    );

    const remaining = warnings.length - renderedCount;
    showMoreBtn.textContent = `Show more (${remaining} remaining)`;
    showMoreBtn.hidden = remaining <= 0;
  }

  showMoreBtn.addEventListener("click", renderMore);

  let expanded = false;
  toggleBtn.addEventListener("click", () => {
    expanded = !expanded;
    body.hidden = !expanded;
    toggleBtn.textContent = expanded ? "Hide details" : "Show details";
    if (expanded && renderedCount === 0) renderMore(); // lazy: render on first expand
  });

  body.appendChild(tableHolder);
  body.appendChild(showMoreBtn);
  return section;
}

function stat(k, v) {
  const wrap = el("div", "stat");
  wrap.appendChild(el("span", "k", k));
  wrap.appendChild(el("span", "v", v == null ? "—" : v));
  return wrap;
}

function addUploadLog(ok, text) {
  if (uploadCount === 0) uploadLog.textContent = ""; // clear the "no uploads" hint
  uploadCount += 1;
  const li = el("li");
  const tag = el("span", ok ? "ok" : "fail", ok ? "✓ " : "✗ ");
  li.appendChild(tag);
  li.appendChild(document.createTextNode(text));
  uploadLog.insertBefore(li, uploadLog.firstChild);
}

uploadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = uploadFile.files && uploadFile.files[0];
  if (!file) return;

  const fileName = file.name;
  uploadBtn.disabled = true;
  uploadBtn.textContent = "Uploading…";

  const body = new FormData();
  body.append("file", file);
  if (uploadType.value) body.append("type", uploadType.value); // omit when auto

  // XHR (not fetch) so the upload phase reports REAL byte progress; once the
  // file finishes sending, the server parses it, so we switch the bar to an
  // indeterminate "processing" trickle until the response arrives.
  progress.start();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/ingest/upload");
  const authToken = getAdminToken();
  if (authToken) xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) progress.set(e.loaded / e.total);
  });
  xhr.upload.addEventListener("load", () => {
    uploadBtn.textContent = "Processing…";
    progress.indeterminate();
  });

  xhr.addEventListener("load", () => {
    if (xhr.status === 401) {
      progress.fail();
      redirectToLogin();
      return;
    }

    let data = {};
    try {
      data = JSON.parse(xhr.responseText || "{}");
    } catch (_) {
      /* leave data empty; handled as a generic failure below */
    }

    if (xhr.status < 200 || xhr.status >= 300) {
      progress.fail();
      setContent(uploadResult, errorBox(data.error || `Upload failed (${xhr.status})`));
      addUploadLog(false, `${fileName}: ${data.error || xhr.status}`);
      resetUploadForm();
      return;
    }

    progress.done();
    renderUploadSuccess(data);
    addUploadLog(
      true,
      `${fileName} → ${data.type}: ${data.mapped}/${data.rowCount} mapped` +
        (data.warnings && data.warnings.length ? `, ${data.warnings.length} warning(s)` : ""),
    );
    // A history upload may introduce new filter values — refresh the dropdowns.
    refreshFilterOptions();
    // Once all 3 workbook types are in, the server just started (or is still
    // running) the background backfill-geocoding job — pick up its status.
    startBackfillStatusPolling();
    resetUploadForm();
  });

  xhr.addEventListener("error", () => {
    progress.fail();
    setContent(uploadResult, errorBox("Could not upload: network error"));
    addUploadLog(false, `${fileName}: network error`);
    resetUploadForm();
  });

  xhr.send(body);
});

function resetUploadForm() {
  uploadBtn.disabled = false;
  uploadBtn.textContent = "Upload";
  uploadForm.reset();
}

// ---------------------------------------------------------------------------
// 2 · History comparison
// ---------------------------------------------------------------------------

const historyForm = document.getElementById("historyForm");
const historyBtn = document.getElementById("historyBtn");
const historyResult = document.getElementById("historyResult");

function renderComparison(result) {
  const vm = summarizeComparison(result);
  if (vm.isMessage) {
    setContent(historyResult, messageBox(vm.message));
    return;
  }

  const frag = document.createDocumentFragment();

  const summary = el("div", "summary-line");
  summary.appendChild(stat("Historical distance", `${vm.historicalDistanceKm} km`));
  summary.appendChild(stat("Optimized distance", `${vm.optimizedDistanceKm} km`));
  const saved = stat("Saved", `${vm.savedKm} km (${vm.savedPct}%)`);
  saved.querySelector(".v").classList.add("saved");
  summary.appendChild(saved);
  frag.appendChild(summary);

  frag.appendChild(
    buildTable(
      [
        "customerCode",
        "customer",
        "historicalSeq",
        "optimizedSeq",
        "historicalEta",
        "optimizedEta",
      ],
      vm.rows,
      [
        (r) => r.customerCode,
        (r) => r.customer,
        (r) => r.historicalSeq,
        (r) => r.optimizedSeq,
        (r) => fmtEta(r.historicalEta),
        (r) => fmtEta(r.optimizedEta),
      ],
    ),
  );

  setContent(historyResult, frag);
}

historyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  historyBtn.disabled = true;
  historyBtn.textContent = "Comparing…";
  progress.start();

  const filters = historyFiltersFromForm(historyForm);

  try {
    const res = await fetch("/api/history/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminAuthHeader() },
      body: JSON.stringify({ filters }),
    });
    if (handledUnauthorized(res)) return;
    const data = await res.json();
    if (!res.ok) {
      progress.fail();
      setContent(historyResult, errorBox(data.error || `Request failed (${res.status})`));
      return;
    }
    progress.done();
    renderComparison(data);
  } catch (err) {
    progress.fail();
    setContent(historyResult, errorBox(`Could not compare: ${err.message}`));
  } finally {
    historyBtn.disabled = false;
    historyBtn.textContent = "Compare";
  }
});

// ---------------------------------------------------------------------------
// 3 · Presale planning
// ---------------------------------------------------------------------------

const presaleForm = document.getElementById("presaleForm");
const presaleBtn = document.getElementById("presaleBtn");
const presaleResult = document.getElementById("presaleResult");

function renderPlan(result) {
  const vm = summarizePlan(result);
  if (vm.isMessage) {
    setContent(presaleResult, messageBox(vm.message));
    return;
  }

  const frag = document.createDocumentFragment();

  if (vm.routes.length === 0) {
    frag.appendChild(el("p", "hint", "No routable stops were produced."));
  }

  for (const route of vm.routes) {
    const block = el("div", "route-block");
    const title = el("div", "route-title");
    title.appendChild(el("span", null, route.vehicleId || "(vehicle)"));
    const depotText = route.depot
      ? `depot ${
          route.depot.code
            ? `${route.depot.code}${route.depot.name ? " " + route.depot.name : ""}`
            : `${route.depot.lat.toFixed(4)}, ${route.depot.lng.toFixed(4)}`
        } · `
      : "";
    title.appendChild(
      el(
        "span",
        "meta",
        `${depotText}${route.fuelType || "—"} · ${route.stops.length} stops · ` +
          `${route.distanceKm} km · ${route.co2Kg} kg CO₂ · load ${route.load}/${route.capacity}`,
      ),
    );
    block.appendChild(title);
    block.appendChild(
      buildTable(
        ["seq", "customer", "ETA", "demand"],
        route.stops,
        [
          (s) => s.sequence,
          (s) => s.customer,
          (s) => fmtEta(s.eta),
          (s) => s.demand,
        ],
      ),
    );
    frag.appendChild(block);
  }

  // Unassigned customers.
  frag.appendChild(el("div", "section-title", `Unassigned (${vm.unassigned.length})`));
  if (vm.unassigned.length > 0) {
    frag.appendChild(
      buildTable(
        ["customerCode", "customer", "reason"],
        vm.unassigned,
        [(u) => u.customerCode, (u) => u.customer, (u) => u.reason],
      ),
    );
  } else {
    frag.appendChild(el("p", "hint", "None."));
  }

  // Working-time-window violations.
  frag.appendChild(
    el("div", "section-title warn-title", `Window violations (${vm.windowViolations.length})`),
  );
  if (vm.windowViolations.length > 0) {
    frag.appendChild(
      buildTable(
        ["customerCode", "ETA", "openTime", "closeTime"],
        vm.windowViolations,
        [
          (w) => w.customerCode,
          (w) => fmtEta(w.eta),
          (w) => w.openTime,
          (w) => w.closeTime,
        ],
      ),
    );
  } else {
    frag.appendChild(el("p", "hint", "None."));
  }

  setContent(presaleResult, frag);
}

presaleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  presaleBtn.disabled = true;
  presaleBtn.textContent = "Planning…";
  progress.start();

  const filters = buildFilters(readFormInputs(presaleForm));

  try {
    const res = await fetch("/api/presale/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminAuthHeader() },
      body: JSON.stringify({ filters }),
    });
    if (handledUnauthorized(res)) return;
    const data = await res.json();
    if (!res.ok) {
      progress.fail();
      setContent(presaleResult, errorBox(data.error || `Request failed (${res.status})`));
      return;
    }
    progress.done();
    renderPlan(data);
  } catch (err) {
    progress.fail();
    setContent(presaleResult, errorBox(`Could not plan: ${err.message}`));
  } finally {
    presaleBtn.disabled = false;
    presaleBtn.textContent = "Plan route";
  }
});

// ---------------------------------------------------------------------------
// Shared: read a form's named text/date inputs into a raw { name: value } map.
// ---------------------------------------------------------------------------

function readFormInputs(form) {
  const inputs = {};
  for (const field of form.querySelectorAll("input[name], select[name]")) {
    inputs[field.name] = field.value;
  }
  return inputs;
}

/** History filter criteria from `historyForm`, trimmed + empties dropped. The
 * single "Day" select (see wireHistoryDayFilter) maps to BOTH
 * deliveryDateFrom and deliveryDateTo — routes are calculated per store PER
 * DAY, so the filter only ever offers one day at a time. */
function historyFiltersFromForm(form) {
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
// Day picker (History comparison filter bar) — GET /api/history/dates,
// scoped by the OTHER active categorical filters and refreshed whenever one
// of them changes, so it only ever offers days that actually have data for
// the current DC/Store/etc. selection.
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

async function refreshHistoryDaySelect(form) {
  const daySelect = form.elements["Day"];
  if (!daySelect) return;
  const dates = await fetchHistoryDates(currentCategoricalFilters(form));
  if (dates) populateSelect(daySelect, dates);
}

/** Wire the Day select to refresh (scoped by the other filters) whenever any
 * of them changes, plus an initial unfiltered populate. */
function wireHistoryDayFilter(form) {
  for (const name of HISTORY_CATEGORICAL_FIELDS) {
    const field = form.elements[name];
    if (field) field.addEventListener("change", () => refreshHistoryDaySelect(form));
  }
  refreshHistoryDaySelect(form);
}

// ---------------------------------------------------------------------------
// Populate the categorical filter dropdowns from the uploaded history data.
// Reset to the full unfiltered lists after each successful upload (new data
// may add values). Cascading ("data hierarchy") narrowing while the user
// picks filters is wired separately per form via `wireCascadingFilters` —
// see the boot section below — so each dropdown's options stay scoped by
// whatever the user has already selected in that same form.
// ---------------------------------------------------------------------------

async function refreshFilterOptions() {
  const options = await fetchFilterOptions();
  if (!options) return;
  populateFilterForm(historyForm, options);
  populateFilterForm(presaleForm, options);
}

// ---------------------------------------------------------------------------
// Background processing status (backfill geocoding) — GET /api/ingest/status
// polled every BACKFILL_POLL_MS while a run is "running", so the UI reflects
// progress in real time without the user refreshing the page. Checked once
// on load too, in case a previous upload's job is still in flight.
// ---------------------------------------------------------------------------

const backfillStatusEl = document.getElementById("backfillStatus");
const backfillStatusLabel = document.getElementById("backfillStatusLabel");
const backfillStatusCounts = document.getElementById("backfillStatusCounts");
const backfillStatusDetail = document.getElementById("backfillStatusDetail");
const backfillProgressFill = document.getElementById("backfillProgressFill");

const BACKFILL_POLL_MS = 2000;
let backfillPollTimer = null;

function renderBackfillStatus(status) {
  if (!status || status.state === "idle") {
    backfillStatusEl.hidden = true;
    return;
  }

  backfillStatusEl.hidden = false;
  backfillStatusEl.classList.remove("done", "error");

  if (status.state === "running") {
    backfillStatusLabel.textContent = "Processing uploaded data — resolving customer locations…";
    const pct =
      status.queriesTotal > 0
        ? Math.round((status.queriesProcessed / status.queriesTotal) * 100)
        : 0;
    backfillProgressFill.style.width = `${pct}%`;
    backfillStatusCounts.textContent = `${status.queriesProcessed}/${status.queriesTotal} locations checked`;
    backfillStatusDetail.textContent = `${status.customersTotal} customer record(s) queued this run.`;
  } else if (status.state === "done") {
    backfillStatusEl.classList.add("done");
    backfillStatusLabel.textContent = "Processing complete";
    backfillProgressFill.style.width = "100%";
    backfillStatusCounts.textContent = `${status.customersResolved} resolved, ${status.customersFailed} unresolved`;
    backfillStatusDetail.textContent = status.finishedAt
      ? `Finished ${new Date(status.finishedAt).toLocaleTimeString()}.`
      : "";
  } else if (status.state === "error") {
    backfillStatusEl.classList.add("error");
    backfillStatusLabel.textContent = "Processing failed";
    backfillStatusDetail.textContent = status.error || "Unknown error.";
  }
}

async function fetchBackfillStatus() {
  try {
    const res = await fetch("/api/ingest/status", { headers: { ...adminAuthHeader() } });
    if (handledUnauthorized(res)) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function startBackfillStatusPolling() {
  if (backfillPollTimer) return; // a poll loop is already running
  const status = await fetchBackfillStatus();
  renderBackfillStatus(status);
  if (!status || status.state !== "running") return;

  backfillPollTimer = setInterval(async () => {
    const s = await fetchBackfillStatus();
    renderBackfillStatus(s);
    if (!s || s.state !== "running") {
      clearInterval(backfillPollTimer);
      backfillPollTimer = null;
    }
  }, BACKFILL_POLL_MS);
}

wireCascadingFilters(historyForm);
wireCascadingFilters(presaleForm);
// Day picker: only offers days that have data for the current selection.
wireHistoryDayFilter(historyForm);
// Pick up an already-running (or just-finished) job from a previous upload.
startBackfillStatusPolling();
