/**
 * User-management service for the admin "User Setup" console.
 *
 * Provides CRUD over the two user types in the system — admins and drivers —
 * on top of the repository layer, with input validation and a few safety
 * guards. It is called ONLY from admin-gated routes (see adminRoutes.js), so it
 * assumes the caller is an authenticated admin; it does not perform auth itself.
 *
 * Passwords are hashed here (scrypt via `credentials.hashPassword`) before they
 * reach the repository, so plaintext never touches the database or the logs.
 *
 * Validation / conflict failures throw {@link UserError}, which carries an HTTP
 * status the route maps directly (400 bad input, 404 not found, 409 duplicate).
 * Dependency injection (`deps`) mirrors the other services for testability.
 */

import * as realRepositories from "../db/repositories.js";
import { hashPassword as realHashPassword } from "../auth/credentials.js";

/** The user types this console can manage. */
const ROLES = new Set(["admin", "driver"]);
const MIN_USERNAME = 3;
const MIN_PASSWORD = 8;

/**
 * A validation / conflict error with an HTTP status (mirrors AuthError's shape).
 * Client-safe message; never leaks internals.
 */
export class UserError extends Error {
  /**
   * @param {string} message client-safe description
   * @param {number} [status] HTTP status the route should surface (default 400)
   */
  constructor(message, status = 400) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

/**
 * List every managed user, grouped by type. Never returns password hashes.
 *
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{ admins: Array<{id:number,username:string}>,
 *   drivers: Array<{id:number,username:string,routeId:string|null}> }>}
 */
export async function listUsers(deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const [admins, drivers] = await Promise.all([
    repositories.listAdmins(),
    repositories.listDrivers(),
  ]);
  return { admins, drivers };
}

function assertRole(role) {
  if (!ROLES.has(role)) {
    throw new UserError("role must be 'admin' or 'driver'");
  }
}

function normalizeUsername(username) {
  const value = typeof username === "string" ? username.trim() : "";
  if (value.length < MIN_USERNAME) {
    throw new UserError(`username must be at least ${MIN_USERNAME} characters`);
  }
  if (/\s/.test(value)) {
    throw new UserError("username must not contain spaces");
  }
  return value;
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new UserError(`password must be at least ${MIN_PASSWORD} characters`);
  }
}

function toId(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw new UserError("a valid user id is required");
  }
  return numId;
}

/**
 * Create a new admin or driver. Duplicate usernames within the target type are
 * rejected with a 409.
 *
 * @param {{ role:string, username:string, password:string, routeId?:string|null }} input
 * @param {{ repositories?: object, hashPassword?: Function }} [deps]
 * @returns {Promise<object>} the created user summary (with its `role`)
 * @throws {UserError}
 */
export async function createUser(
  { role, username, password, routeId } = {},
  deps = {}
) {
  const repositories = deps.repositories || realRepositories;
  const hash = deps.hashPassword || realHashPassword;

  assertRole(role);
  const uname = normalizeUsername(username);
  assertPassword(password);

  const passwordHash = await hash(password);

  let created;
  if (role === "admin") {
    created = await repositories.createAdmin(uname, passwordHash);
  } else {
    const rid =
      typeof routeId === "string" && routeId.trim() !== "" ? routeId.trim() : null;
    created = await repositories.createDriver(uname, passwordHash, rid);
  }

  if (!created) {
    throw new UserError(`a ${role} named "${uname}" already exists`, 409);
  }
  return { role, ...created };
}

/**
 * Reset an existing user's password.
 *
 * @param {{ role:string, id:(number|string), password:string }} input
 * @param {{ repositories?: object, hashPassword?: Function }} [deps]
 * @returns {Promise<{ role:string, id:number }>}
 * @throws {UserError}
 */
export async function resetPassword({ role, id, password } = {}, deps = {}) {
  const repositories = deps.repositories || realRepositories;
  const hash = deps.hashPassword || realHashPassword;

  assertRole(role);
  const numId = toId(id);
  assertPassword(password);

  const passwordHash = await hash(password);
  const rowCount =
    role === "admin"
      ? await repositories.updateAdminPassword(numId, passwordHash)
      : await repositories.updateDriverPassword(numId, passwordHash);

  if (rowCount === 0) {
    throw new UserError("user not found", 404);
  }
  return { role, id: numId };
}

/**
 * Delete a user. Guards against an admin deleting their own account or removing
 * the last remaining admin (which would lock everyone out).
 *
 * @param {{ role:string, id:(number|string) }} input
 * @param {number|null} [actingAdminId] the id of the admin performing the delete
 * @param {{ repositories?: object }} [deps]
 * @returns {Promise<{ role:string, id:number }>}
 * @throws {UserError}
 */
export async function deleteUser({ role, id } = {}, actingAdminId = null, deps = {}) {
  const repositories = deps.repositories || realRepositories;

  assertRole(role);
  const numId = toId(id);

  if (role === "admin") {
    if (actingAdminId != null && numId === Number(actingAdminId)) {
      throw new UserError("you cannot delete your own admin account");
    }
    const remaining = await repositories.countAdmins();
    if (remaining <= 1) {
      throw new UserError("cannot delete the last admin");
    }
    const rowCount = await repositories.deleteAdminById(numId);
    if (rowCount === 0) {
      throw new UserError("user not found", 404);
    }
  } else {
    const rowCount = await repositories.deleteDriverById(numId);
    if (rowCount === 0) {
      throw new UserError("user not found", 404);
    }
  }

  return { role, id: numId };
}
