/**
 * Shared admin-session guard middleware.
 *
 * Extracts the `Authorization: Bearer <token>` header, resolves it against the
 * admin sessions, and either attaches the session to `req.admin` and continues,
 * or responds `401 { error: "unauthorized" }` without calling the handler.
 *
 * Kept in its own module so every admin-only router (the admin user-management
 * endpoints AND the gated planner/ingest/optimizer endpoints) shares ONE
 * definition.
 *
 * SECURITY NOTE: the driver endpoints (`/api/driver/*`) use their own driver
 * session and must NOT use this guard; `/api/health` and the admin login/logout
 * endpoints stay open.
 */

import { resolveSession } from "../services/adminService.js";

/**
 * Read the bearer token from the `Authorization` header, or `null` when the
 * header is absent/malformed (treated as unauthenticated).
 * @param {import("express").Request} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  const header = (req.get && req.get("authorization")) || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

/**
 * Express middleware: require a valid admin session. On success attaches
 * `req.admin = { adminId, username }`; otherwise responds 401.
 */
export async function requireAdmin(req, res, next) {
  try {
    const session = await resolveSession(extractBearerToken(req));
    if (!session) {
      return res.status(401).json({ error: "unauthorized" });
    }
    req.admin = session;
    next();
  } catch (err) {
    next(err);
  }
}
