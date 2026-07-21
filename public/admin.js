/* Farmhouse Admin — portal + User Setup console controller.
 *
 * Three views on one page:
 *   0. Setup (first run ONLY, before any admin exists) — POSTs to
 *      /api/admin/setup, which bootstraps the very first admin and signs them
 *      in. Shown instead of Login when GET /api/admin/setup-status reports
 *      `needsSetup: true`; unreachable again once an admin exists (the
 *      endpoint itself re-checks this server-side).
 *   1. Login (while unauthenticated) — POSTs to /api/admin/login and stores the
 *      bearer token in sessionStorage.
 *   2. Console (after authentication) — a "User setup" menu that lists, creates,
 *      resets, and deletes users of every type (admins + drivers) against the
 *      admin-gated /api/admin/users endpoints, plus quick links to the dashboard
 *      and planner.
 *
 * All console requests send `Authorization: Bearer <token>`; a 401 drops back to
 * the login view. Server-provided text (usernames, route ids) is rendered with
 * textContent / DOM APIs — never innerHTML — so it cannot inject markup.
 */

import * as progress from "./progress.js";
import { fetchFilterOptions, populateSelect } from "./filterOptions.js";

const TOKEN_KEY = "farmhouse.admin.token";

let token = null;

// --- DOM handles ------------------------------------------------------------
const setupView = document.getElementById("setupView");
const setupForm = document.getElementById("setupForm");
const setupBtn = document.getElementById("setupBtn");
const setupError = document.getElementById("setupError");

const loginView = document.getElementById("loginView");
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");

const consoleView = document.getElementById("consoleView");
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");

const addUserForm = document.getElementById("addUserForm");
const addUserBtn = document.getElementById("addUserBtn");
const addUserError = document.getElementById("addUserError");
const roleSelect = document.getElementById("roleSelect");
const routeField = document.getElementById("routeField");
const adminList = document.getElementById("adminList");
const driverList = document.getElementById("driverList");

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

// --- Token storage ----------------------------------------------------------
function setToken(value) {
  token = value;
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
  } catch (_) {
    /* private mode — in-memory token still works for this session */
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
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* ignore */
  }
}

// --- View switching ---------------------------------------------------------
function showSetup() {
  consoleView.hidden = true;
  loginView.hidden = true;
  setupView.hidden = false;
}

function showLogin() {
  consoleView.hidden = true;
  setupView.hidden = true;
  loginView.hidden = false;
}

function showConsole(username) {
  setupView.hidden = true;
  loginView.hidden = true;
  consoleView.hidden = false;
  whoami.textContent = username ? `Signed in as ${username}` : "";
}

/** Decide between the Setup and Login views by asking the server whether an
 * admin has ever been created. Defaults to Login on any failure (network
 * error, unexpected response) so a transient hiccup never blocks sign-in. */
async function showLoginOrSetup() {
  try {
    const res = await fetch("/api/admin/setup-status");
    const data = res.ok ? await res.json() : null;
    if (data && data.needsSetup) {
      showSetup();
      return;
    }
  } catch (_) {
    /* fall through to login */
  }
  showLogin();
}

// --- Network helpers --------------------------------------------------------
/** Thrown to unwind an admin request after the session was rejected (401). */
class Unauthorized extends Error {}

/**
 * fetch wrapper that attaches the bearer token. A 401 clears the token, returns
 * the user to the login view, and throws Unauthorized so callers stop.
 */
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Unauthorized();
  }
  return res;
}

// --- Setup (first run only) --------------------------------------------------
async function handleSetup(event) {
  event.preventDefault();
  setupError.hidden = true;

  const username = setupForm.elements.username.value;
  const password = setupForm.elements.password.value;
  const passwordConfirm = setupForm.elements.passwordConfirm.value;
  if (password !== passwordConfirm) {
    setupError.textContent = "Passwords do not match.";
    setupError.hidden = false;
    return;
  }

  setupBtn.disabled = true;
  progress.start();
  try {
    const res = await fetch("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      progress.fail();
      setupError.textContent = data.error || `Could not create the admin account (${res.status}).`;
      setupError.hidden = false;
      return;
    }
    setToken(data.token);
    setupForm.reset();
    showConsole(data.username);
    await Promise.all([loadUsers(), loadStoreOptions()]);
    progress.done();
  } catch (_) {
    progress.fail();
    setupError.textContent = "Could not complete setup. Check your connection and try again.";
    setupError.hidden = false;
  } finally {
    setupBtn.disabled = false;
  }
}

// --- Login ------------------------------------------------------------------
async function handleLogin(event) {
  event.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  progress.start();
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameEl.value, password: passwordEl.value }),
    });
    if (!res.ok) {
      progress.fail();
      loginError.textContent = "Invalid username or password.";
      loginError.hidden = false;
      return;
    }
    const data = await res.json();
    setToken(data.token);
    passwordEl.value = "";
    showConsole(data.username);
    await Promise.all([loadUsers(), loadStoreOptions()]);
    progress.done();
  } catch (_) {
    progress.fail();
    loginError.textContent = "Could not sign in. Check your connection and try again.";
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
  }
}

async function handleLogout() {
  progress.start();
  try {
    await authFetch("/api/admin/logout", { method: "POST" });
  } catch (_) {
    /* ignore — we clear locally regardless */
  } finally {
    clearToken();
    showLogin();
    progress.done();
  }
}

// --- User Setup: store (route) dropdown -------------------------------------
/**
 * Populate the "Store (route)" dropdown from the distinct StoreName values in
 * the uploaded history data, so a driver is assigned to a real store rather
 * than an arbitrary typed string.
 */
async function loadStoreOptions() {
  const options = await fetchFilterOptions();
  const stores = options && Array.isArray(options.StoreName) ? options.StoreName : [];
  // The select already has a "(none)" placeholder option (value ""); populateSelect
  // preserves it and appends the distinct store names as options.
  populateSelect(addUserForm.elements.routeId, stores);
}

// --- User Setup: list + render ---------------------------------------------
async function loadUsers() {
  try {
    const res = await authFetch("/api/admin/users");
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    renderAdmins(Array.isArray(data.admins) ? data.admins : []);
    renderDrivers(Array.isArray(data.drivers) ? data.drivers : []);
  } catch (err) {
    if (err instanceof Unauthorized) return;
    setChildren(adminList, [el("p", "hint", `Could not load users: ${err.message}`)]);
    setChildren(driverList, []);
  }
}

function actionButtons(role, user) {
  const wrap = el("div", "row-actions");

  const reset = el("button", "btn secondary small", "Reset password");
  reset.type = "button";
  reset.addEventListener("click", () => onResetPassword(role, user));
  wrap.appendChild(reset);

  const del = el("button", "btn danger small", "Delete");
  del.type = "button";
  del.addEventListener("click", () => onDeleteUser(role, user));
  wrap.appendChild(del);

  return wrap;
}

function renderAdmins(admins) {
  if (admins.length === 0) {
    setChildren(adminList, [el("p", "hint", "No admins.")]);
    return;
  }
  const table = el("table", "user-table");
  const thead = el("thead");
  const htr = el("tr");
  htr.appendChild(el("th", null, "Username"));
  htr.appendChild(el("th", null, "Actions"));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const admin of admins) {
    const tr = el("tr");
    tr.appendChild(el("td", null, admin.username));
    const actions = el("td");
    actions.appendChild(actionButtons("admin", admin));
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  setChildren(adminList, [table]);
}

function renderDrivers(drivers) {
  if (drivers.length === 0) {
    setChildren(driverList, [el("p", "hint", "No drivers.")]);
    return;
  }
  const table = el("table", "user-table");
  const thead = el("thead");
  const htr = el("tr");
  htr.appendChild(el("th", null, "Username"));
  htr.appendChild(el("th", null, "Store"));
  htr.appendChild(el("th", null, "Actions"));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const driver of drivers) {
    const tr = el("tr");
    tr.appendChild(el("td", null, driver.username));
    tr.appendChild(el("td", null, driver.routeId || "—"));
    const actions = el("td");
    actions.appendChild(actionButtons("driver", driver));
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  setChildren(driverList, [table]);
}

// --- User Setup: create / reset / delete ------------------------------------
async function onAddUser(event) {
  event.preventDefault();
  addUserError.hidden = true;
  addUserBtn.disabled = true;
  progress.start();

  const payload = {
    role: roleSelect.value,
    username: addUserForm.elements.username.value,
    password: addUserForm.elements.password.value,
    routeId: addUserForm.elements.routeId.value,
  };

  try {
    const res = await authFetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      progress.fail();
      addUserError.textContent = data.error || `Could not add user (${res.status}).`;
      addUserError.hidden = false;
      return;
    }
    progress.done();
    addUserForm.reset();
    updateRouteFieldVisibility();
    await loadUsers();
  } catch (err) {
    if (err instanceof Unauthorized) return;
    progress.fail();
    addUserError.textContent = `Could not add user: ${err.message}`;
    addUserError.hidden = false;
  } finally {
    addUserBtn.disabled = false;
  }
}

async function onResetPassword(role, user) {
  const password = window.prompt(`New password for ${user.username} (min 8 chars):`);
  if (password == null) return; // cancelled
  progress.start();
  try {
    const res = await authFetch("/api/admin/users/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, id: user.id, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      progress.fail();
      window.alert(data.error || `Could not reset password (${res.status}).`);
      return;
    }
    progress.done();
    window.alert(`Password updated for ${user.username}.`);
  } catch (err) {
    if (err instanceof Unauthorized) return;
    progress.fail();
    window.alert(`Could not reset password: ${err.message}`);
  }
}

async function onDeleteUser(role, user) {
  if (!window.confirm(`Delete ${role} "${user.username}"? This cannot be undone.`)) {
    return;
  }
  progress.start();
  try {
    const res = await authFetch("/api/admin/users/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, id: user.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      progress.fail();
      window.alert(data.error || `Could not delete user (${res.status}).`);
      return;
    }
    progress.done();
    await loadUsers();
  } catch (err) {
    if (err instanceof Unauthorized) return;
    progress.fail();
    window.alert(`Could not delete user: ${err.message}`);
  }
}

/** The Route ID field only applies to drivers. */
function updateRouteFieldVisibility() {
  routeField.hidden = roleSelect.value !== "driver";
}

// --- Boot -------------------------------------------------------------------
async function resumeSession() {
  const stored = getStoredToken();
  if (!stored) {
    await showLoginOrSetup();
    return;
  }
  token = stored;
  try {
    const res = await fetch("/api/admin/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      showConsole(data.username);
      await Promise.all([loadUsers(), loadStoreOptions()]);
    } else {
      clearToken();
      await showLoginOrSetup();
    }
  } catch (_) {
    // Offline / server down — show login so the admin can retry.
    showLogin();
  }
}

setupForm.addEventListener("submit", handleSetup);
loginForm.addEventListener("submit", handleLogin);
logoutBtn.addEventListener("click", handleLogout);
addUserForm.addEventListener("submit", onAddUser);
roleSelect.addEventListener("change", updateRouteFieldVisibility);

updateRouteFieldVisibility();
resumeSession();
