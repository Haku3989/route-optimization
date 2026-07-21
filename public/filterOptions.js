/**
 * Shared helper for the data-driven filter dropdowns.
 *
 * Fetches the distinct filter values sourced from the uploaded history data
 * (`GET /api/filters`, admin-gated) and populates `<select name="...">` controls
 * whose `name` matches a returned key (DC_Name, StoreName, StoreGroup,
 * "Store Area", CustomerType). Each select keeps a leading "(any)" placeholder
 * (empty value) so "no selection" means "no filter".
 */

import { adminAuthHeader, handledUnauthorized } from "./adminAuth.js";

/**
 * Fetch the filter option lists, or `null` when unavailable (network error, or
 * a 401 which also triggers a redirect to login).
 * @returns {Promise<Record<string, string[]>|null>}
 */
export async function fetchFilterOptions() {
  try {
    const res = await fetch("/api/filters", { headers: { ...adminAuthHeader() } });
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
