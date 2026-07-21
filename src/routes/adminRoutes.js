/**
 * Admin auth router (admin portal login).
 *
 *   POST /api/admin/login    { username, password } -> { token, username }
 *   GET  /api/admin/me        Authorization: Bearer <token> -> { username }
 *   POST /api/admin/logout    Authorization: Bearer <token> -> { ok: true }
 *
 * Login delegates to `adminService.login`; any failure (unknown user, bad
 * password, malformed input) surfaces as the SAME generic AuthError, translated
 * here to `401 { error: "invalid username or password" }` so neither field is
 * revealed. A DB/other error forwards to the central handler (500).
 *
 * `GET /me` lets the client confirm a stored token is still valid on load; it
 * returns the admin's username or 401 with no other data.
 *
 * SECURITY NOTE: this admin token currently gates only the admin portal page.
 * The planner/dashboard API endpoints remain unauthenticated in this prototype
 * — require this session on those routes before any non-prototype deployment.
 */

import { Router } from "express";

import { login, getAdmin, logout } from "../services/adminService.js";
import {
  listUsers,
  createUser,
  resetPassword,
  deleteUser,
  UserError,
} from "../services/userService.js";
import { requireAdmin, extractBearerToken } from "./requireAdmin.js";
import { AuthError } from "../auth/credentials.js";

const router = Router();

/** Map a UserError to its HTTP status; forward anything else to the handler. */
function handleUserError(err, res, next) {
  if (err instanceof UserError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  next(err);
}

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await login(username, password);
    res.json(result); // { token, username }
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ error: err.message });
    }
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    const result = await getAdmin(token);
    res.json(result); // { username }
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ error: err.message });
    }
    next(err);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await logout(extractBearerToken(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// User Setup — admin-gated management of all user types (admins + drivers).
// ---------------------------------------------------------------------------

router.get("/users", requireAdmin, async (_req, res, next) => {
  try {
    res.json(await listUsers()); // { admins, drivers }
  } catch (err) {
    next(err);
  }
});

router.post("/users", requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json(await createUser(req.body || {}));
  } catch (err) {
    handleUserError(err, res, next);
  }
});

router.post("/users/reset-password", requireAdmin, async (req, res, next) => {
  try {
    res.json(await resetPassword(req.body || {}));
  } catch (err) {
    handleUserError(err, res, next);
  }
});

router.post("/users/delete", requireAdmin, async (req, res, next) => {
  try {
    res.json(await deleteUser(req.body || {}, req.admin.adminId));
  } catch (err) {
    handleUserError(err, res, next);
  }
});

export default router;
