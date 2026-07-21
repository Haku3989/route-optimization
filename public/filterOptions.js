/**
 * Shared helper for the data-driven filter dropdowns.
 *
 * Fetches the distinct filter values sourced from the uploaded history data
 * (`GET /api/filters`, admin-gated) and populates `<select name="...">` controls
 * whose `name` matches a returned key (DC_Name, StoreName, StoreGroup,
 * "Store Area", CustomerType). Each select keeps a leading "(any)" placeholder
 * (empty value) so "no selection" means "no filter".
 *
 * Cascading ("data hierarchy") behavior: `wireCascadingFilters` re-fetches the
 * option lists — scoped by whichever filters are currently selected — every
 * time one of the form's selects changes, so e.g. picking a DC_Name narrows
 * StoreName down to that DC's own stores instead of always listing every
 * value in the dataset. The scoping itself happens server-side
 * (`distinctHistoryFilterValues`); this module just supplies the current
 * selection as query parameters and repopulates the form with the result.
 */

import { adminAuthHeader, handledUnauthorized } from "./adminAuth.js";

/**
 * Fetch the filter option lists, optionally SCOPED by the currently selected
 * filter values (cascading/hierarchical narrowing — see module header).
 * Omit `activeFilters` (or pass `{}`) for the full unfiltered lists.
 * @param {Record<string,string>} [activeFilters]
 * @returns {Promise<Record<string, string[]>|null>} `null` when unavailable
 *   (network error, or a 401 which also triggers a redirect to login).
 */
export async function fetchFilterOptions(activeFilters = {}) {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(activeFilters)) {
      if (typeof value === "string" && value.trim() !== "") params.set(key, value);
    }
    const qs = params.toString();
    const res = await fetch(`/api/filters${qs ? `?${qs}` : ""}`, {
      headers: { ...adminAuthHeader() },
    });
    if (handledUnauthorized(res)) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Populate a single <select> with `values`, preserving a leading empty
 * "(any)" placeholder and the current selection when it is still valid.
 * @param {HTMLSelectElement} select
 * @param {string[]} values
 */
export function populateSelect(select, values) {
  const previous = select.value;

  // Preserve (or create) the empty placeholder option, then rebuild the list.
  let placeholder = null;
  for (const opt of select.options) {
    if (opt.value === "") {
      placeholder = opt;
      break;
    }
  }
  select.textContent = "";
  if (placeholder) {
    select.appendChild(placeholder);
  } else {
    const any = document.createElement("option");
    any.value = "";
    any.textContent = "(any)";
    select.appendChild(any);
  }

  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }

  // Restore the previous selection if it still exists among the new options.
  if ([...select.options].some((o) => o.value === previous)) {
    select.value = previous;
  }
}

/**
 * Populate every `select[name]` in `form` from `options[name]`.
 * @param {HTMLFormElement} form
 * @param {Record<string, string[]>} options
 */
export function populateFilterForm(form, options) {
  if (!form || !options) return;
  for (const select of form.querySelectorAll("select[name]")) {
    const values = options[select.name];
    if (Array.isArray(values)) populateSelect(select, values);
  }
}

/** Read a filter form's select values into a `{ name: value }` map, dropping
 * unselected ("(any)") fields so they never scope a query. */
function currentFilterSelection(form) {
  const out = {};
  for (const select of form.querySelectorAll("select[name]")) {
    if (select.value) out[select.name] = select.value;
  }
  return out;
}

/**
 * Wire cascading ("data hierarchy") behavior onto a filter form: does an
 * initial unfiltered fetch/populate, then — whenever any filter select
 * changes — refetches the option lists scoped by the rest of the current
 * selection and repopulates every select, so each dropdown only offers
 * values that still co-occur with the selection made so far (e.g. picking a
 * DC_Name narrows StoreName to that DC's own stores). A selection that no
 * longer co-occurs with the new scope is dropped back to "(any)" by
 * `populateSelect`.
 * @param {HTMLFormElement} form
 * @returns {Promise<void>} resolves after the initial populate
 */
export async function wireCascadingFilters(form) {
  if (!form) return;

  async function refresh() {
    const options = await fetchFilterOptions(currentFilterSelection(form));
    if (options) populateFilterForm(form, options);
  }

  for (const select of form.querySelectorAll("select[name]")) {
    select.addEventListener("change", refresh);
  }

  await refresh();
}
