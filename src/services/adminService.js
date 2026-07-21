/**
 * Admin service — authentication and session resolution for the admin portal.
 *
 * Mirrors `driverService` (same security posture and dependency-injection
 * seams) but for the `admins` / `admin_sessions` tables and without any route
 * assignment: an admin authenticates to reach the planner + dashboard.
 *
 * ## Dependency injection (`deps` bag)
 *
 * Every function accepts an optional `deps` object so tests can substitute
 * fakes for the persistence + crypto seams:
 *   - `repositories`   — defaults to the real `../db/repositories.js`
 *                        (`findAdminByUsername`, `insertAdminSession`,
 *                        `findAdminSession`, `deleteAdminSession`).
 *   - `verifyPassword` — defaults to the real timing-safe verifier.
 *   - `newToken`       — defaults to the real 32-byte hex token minter.
 *
 * ## Security choices (stated explicitly)
 *   - Any login failure — unknown username OR bad password OR malformed input —
 *     throws the SAME generic `AuthError`, so a caller cannot tell which field
 *     was wrong.
 *   - Passwords are checked with the timing-safe `verifyPassword`; the plaintext
 *     is never stored or logged.
 *   - `resolveSession` treats an absent OR expired session as unauthenticated.
 *
 * SECURITY NOTE: this is a prototype. The admin token gates the admin portal
 * page, but the planner/dashboard API endpoints themselves remain unauthenticated
 * for now — enforce this session on those routes before any real deployment.
 *
 * ## First-run setup (`getSetupStatus` / `setupFirstAdmin`)
 *
 * A fresh database has no admin, so nobody CAN authenticate to create one via
 * the normal admin-gated `POST /api/admin/users`. `setupFirstAdmin` is a
 * deliberately unauthenticated bootstrap that creates the very FIRST admin
 * and signs them in — but it is strictly gated by the current admin COUNT
 * (`repositories.countAdmins()`), not by any token, so it can only ever
 * succeed once: the moment a single admin exists, every later call is
 * rejected regardless of who calls it. The login page checks
 * `getSetupStatus` on load to decide whether to show the setup form or the
 * normal sign-in form.
 */

import * as realRepositories from "../db/repositories.js";
import {
  AuthError,
  verifyPassword as realVerifyPassword,
  newToken as realNewToken,
} from "../auth/credentials.js";
import { createUser, UserError } from "./userService.js";

/**
 * Authenticate an admin and issue a persisted bearer token.
 *
 * On ANY failure (unknown username, wrong password, or an admin row with a
 * malformed hash) this throws a generic {@link AuthError} whose message reveals
 * neither field. A token is only minted and persisted after a successful
 * password check, so a failed login never creates a session.
 *
 * @param {string} username submitted admin username
 * @param {string} password submitted plaintext password
 * @param {{ repositories?: object, verifyPassword?: Function, newToken?: Function }} [deps]
 * @returns {Promise<{ token: string, username: string }>}
 * @throws {AuthError} on any authentication failure
 */
export async function login(username, password, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const verify = deps.verifyPassword || realVerifyPassword;
  const mintToken = deps.newToken || realNewToken;

  const admin = await repositories.findAdminByUsername(username);
  // Unknown username -> generic denial (do not reveal that the user is unknown).
  if (!admin) {
    throw new AuthError();
  }
  // Wrong password -> the SAME generic denial (indistinguishable from above).
  if (!verify(password, admin.passwordHash)) {
    throw new AuthError();
  }

  const token = mintToken();
  await repositories.insertAdminSession(token, admin.id);
  return { token, username: admin.username };
}

/**
 * Resolve a bearer token to its admin session, or `null` when the token is not
 * a currently valid session.
 *
 * Returns `null` when the token is missing / not a non-empty string, no session
 * row exists for it, or the session has an `expiresAt` at/before now.
 *
 * @param {unknown} token the bearer token to resolve
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{ adminId: number, username: string }|null>}
 */
export async function resolveSession(token, deps = {}) {
  const repositories = deps.repositories || realRepositories;

  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const session = await repositories.findAdminSession(token);
  if (!session) {
    return null;
  }

  // Treat an expired session as unauthenticated. A null/absent expiresAt means
  // the session does not expire on a timestamp basis.
  if (session.expiresAt != null) {
    const expires =
      session.expiresAt instanceof Date
        ? session.expiresAt
        : new Date(session.expiresAt);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) {
      return null;
    }
  }

  return { adminId: session.adminId, username: session.username };
}

/**
 * Return the authenticated admin's public identity, or throw {@link AuthError}
 * when the token is invalid. Used by `GET /api/admin/me` so the client can
 * confirm a stored token is still valid on load.
 *
 * @param {unknown} token bearer token from the `Authorization: Bearer` header
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{ username: string }>}
 * @throws {AuthError} when the token does not resolve to a valid session
 */
export async function getAdmin(token, deps = {}) {
  const session = await resolveSession(token, deps);
  if (!session) {
    throw new AuthError();
  }
  return { username: session.username };
}

/**
 * Invalidate an admin session (logout). Deleting an absent/blank token is a
 * no-op, so logout is always safe to call.
 *
 * @param {unknown} token the bearer token to invalidate
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<void>}
 */
export async function logout(token, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  if (typeof token === "string" && token.length > 0) {
    await repositories.deleteAdminSession(token);
  }
}

/**
 * Whether the system has never had an admin created yet — used to gate the
 * one-time bootstrap "set up admin" flow on the login page (see module
 * header). Safe to call unauthenticated: it reveals only a boolean, never
 * any account details.
 *
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{ needsSetup: boolean }>}
 */
export async function getSetupStatus(deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const count = await repositories.countAdmins();
  return { needsSetup: count === 0 };
}

/**
 * Bootstrap the FIRST admin account and sign them in. Only succeeds while NO
 * admin exists yet (re-checked here, not just left to the caller's
 * `getSetupStatus` check, so a second call after setup has completed is
 * always rejected regardless of client state). Delegates username/password
 * validation and hashing to `userService.createUser` — see its rules (min
 * length, no-space username, etc.).
 *
 * @param {string} username
 * @param {string} password
 * @param {{ repositories?: object, newToken?: Function }} [deps]
 * @returns {Promise<{ token: string, username: string }>}
 * @throws {UserError} invalid input, or setup has already been completed (409)
 */
export async function setupFirstAdmin(username, password, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const mintToken = deps.newToken || realNewToken;

  const count = await repositories.countAdmins();
  if (count > 0) {
    throw new UserError("setup has already been completed — sign in instead", 409);
  }

  const created = await createUser({ role: "admin", username, password }, { repositories });

  const token = mintToken();
  await repositories.insertAdminSession(token, created.id);
  return { token, username: created.username };
}
