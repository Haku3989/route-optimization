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

  // Warnings table.
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.length > 0) {
    frag.appendChild(el("div", "section-title warn-title", `Warnings (${warnings.length})`));
    frag.appendChild(
      buildTable(
        ["row / id", "reason"],
        warnings,
        [(w) => (w.id != null ? w.id : w.row != null ? w.row : "—"), (w) => w.reason],
      ),
    );
  } else {
    frag.appendChild(el("p", "hint", "No warnings."));
  }

  setContent(uploadResult, frag);
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

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = uploadFile.files && uploadFile.files[0];
  if (!file) return;

  uploadBtn.disabled = true;
  uploadBtn.textContent = "Uploading…";

  const body = new FormData();
  body.append("file", file);
  if (uploadType.value) body.append("type", uploadType.value); // omit when auto

  try {
    const res = await fetch("/api/ingest/upload", { method: "POST", body });
    const data = await res.json();

    if (!res.ok) {
      setContent(uploadResult, errorBox(data.error || `Upload failed (${res.status})`));
      addUploadLog(false, `${file.name}: ${data.error || res.status}`);
      return;
    }

    renderUploadSuccess(data);
    addUploadLog(
      true,
      `${file.name} → ${data.type}: ${data.mapped}/${data.rowCount} mapped` +
        (data.warnings && data.warnings.length ? `, ${data.warnings.length} warning(s)` : ""),
    );
  } catch (err) {
    setContent(uploadResult, errorBox(`Could not upload: ${err.message}`));
    addUploadLog(false, `${file.name}: ${err.message}`);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload";
    uploadForm.reset();
  }
});

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

  const filters = buildFilters(readFormInputs(historyForm));

  try {
    const res = await fetch("/api/history/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters }),
    });
    const data = await res.json();
    if (!res.ok) {
      setContent(historyResult, errorBox(data.error || `Request failed (${res.status})`));
      return;
    }
    renderComparison(data);
  } catch (err) {
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
    title.appendChild(
      el(
        "span",
        "meta",
        `${route.fuelType || "—"} · ${route.stops.length} stops · ` +
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

  const filters = buildFilters(readFormInputs(presaleForm));

  try {
    const res = await fetch("/api/presale/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters }),
    });
    const data = await res.json();
    if (!res.ok) {
      setContent(presaleResult, errorBox(data.error || `Request failed (${res.status})`));
      return;
    }
    renderPlan(data);
  } catch (err) {
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
  for (const field of form.querySelectorAll("input[name]")) {
    inputs[field.name] = field.value;
  }
  return inputs;
}
