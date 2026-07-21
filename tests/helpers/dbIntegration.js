/**
 * Shared harness for the DB-backed integration tests (tasks 3.4, 16.1–16.3).
 *
 * These tests exercise the REAL `pg` repository layer / SQL and therefore
 * require a Postgres instance reachable via `DATABASE_URL`. They MUST skip
 * cleanly — never fail and never hang — when no database is configured.
 *
 * Design ("Testing Strategy > Integration tests"): connect via a `DATABASE_URL`
 * pointing at a disposable schema, apply `db/schema.sql` once, truncate/reset
 * all tables between tests for isolation, and skip with a clear message when
 * `DATABASE_URL` is absent.
 *
 * ## Skip-clean contract
 *
 * `DB_SKIP` is `false` when a database is configured (tests run) or a reason
 * STRING when it is not (node:test shows it as the skip reason). Test files pass
 * it straight to `test(name, { skip: DB_SKIP }, fn)` and guard every hook with
 * `if (DB_SKIP) return;`.
 *
 * ## Why lazy imports
 *
 * `src/db/pool.js` constructs the shared `pg.Pool` at import time and
 * `src/server.js` imports it transitively. To honour "when skipped, do NOT open
 * the pool or start the server at all", nothing DB/server-related is imported
 * statically here — the loaders below dynamically import those modules, so a
 * skipped run never touches the database layer.
 */

/** Raw connection string; `undefined` means no database is configured. */
export const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Falsy => run the tests; a string => node:test skips them and prints the
 * reason. Only the absence of `DATABASE_URL` triggers a skip (a configured but
 * unreachable DB is a real failure, surfaced by the `before` hook).
 */
export const DB_SKIP = DATABASE_URL
  ? false
  : "DATABASE_URL not set — DB integration test skipped (no Postgres available)";

/** Dynamically load the connection pool module (constructs the pool). */
export async function loadPool() {
  return import("../../src/db/pool.js");
}

/** Dynamically load the repository layer. */
export async function loadRepositories() {
  return import("../../src/db/repositories.js");
}

/** Dynamically load the Express app (does NOT auto-connect to the DB). */
export async function loadApp() {
  const mod = await import("../../src/server.js");
  return mod.default;
}

/**
 * Start the Express app on an ephemeral port.
 * @param {import("express").Express} app
 * @returns {Promise<{ server: import("http").Server, baseUrl: string }>}
 */
export function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
    server.once("error", reject);
  });
}

/**
 * Close a server started by {@link startServer}. Safe to call with a nullish
 * server (resolves immediately).
 * @param {import("http").Server|null|undefined} server
 * @returns {Promise<void>}
 */
export function stopServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Seed a throwaway admin and log in, returning an `Authorization` header object
 * for the gated endpoints (/api/ingest, /api/history, /api/presale, /api/plan).
 *
 * Call AFTER `truncateAll()` (which clears the admins table) so the admin is
 * created fresh for the test. Uses the real password hasher + login route, so
 * it exercises the same auth path the app uses.
 *
 * @param {string} baseUrl running server base URL
 * @param {{ username?: string, password?: string }} [creds]
 * @returns {Promise<{ Authorization: string }>}
 */
export async function authAsAdmin(
  baseUrl,
  { username = "it-admin", password = "it-admin-pass-123" } = {}
) {
  const { hashPassword } = await import("../../src/auth/credentials.js");
  const repositories = await loadRepositories();
  await repositories.createAdmin(username, await hashPassword(password));

  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const { token } = await res.json();
  return { Authorization: `Bearer ${token}` };
}
