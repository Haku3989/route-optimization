/**
 * Shared client-side admin-auth helpers for the gated pages (dashboard +
 * planner). The admin bearer token is stored in sessionStorage by the admin
 * login page (admin.js); these helpers read it, attach it to requests, and send
 * the user back to the login page when it is missing or rejected.
 *
 * NOTE: this is UX-level gating only — the real enforcement is server-side
 * (requireAdmin returns 401). These helpers just avoid firing doomed requests
 * and route the user to sign in.
 */

const TOKEN_KEY = "farmhouse.admin.token";
const LOGIN_URL = "admin.html";

/** The stored admin bearer token, or null when not signed in. */
export function getAdminToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch (_) {
    return null;
  }
}

/** Authorization header object (spread into fetch headers), or {} when absent. */
export function adminAuthHeader() {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Send the browser to the admin login page. */
export function redirectToLogin() {
  window.location.replace(LOGIN_URL);
}

/**
 * Ensure an admin token is present; if not, redirect to login and return false
 * so callers can skip their boot work.
 * @returns {boolean} true when signed in
 */
export function ensureAdmin() {
  if (getAdminToken()) return true;
  redirectToLogin();
  return false;
}

/**
 * Given a fetch Response, if it is a 401 clear nothing but redirect to login and
 * return true (caller should stop). Returns false otherwise.
 * @param {Response} res
 * @returns {boolean} true when the response was an auth failure (redirecting)
 */
export function handledUnauthorized(res) {
  if (res && res.status === 401) {
    redirectToLogin();
    return true;
  }
  return false;
}
