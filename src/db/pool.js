/**
 * PostgreSQL connection pool.
 *
 * A single shared `pg.Pool` is built from environment configuration, mirroring
 * the env-based pattern used elsewhere (e.g. LONGDO_API_KEY for the routing
 * layer). No credentials are ever hard-coded.
 *
 * Configuration (read at import time):
 *   - DATABASE_URL  e.g. "postgres://user:pass@host:5432/dbname"  (takes precedence)
 *   - otherwise the standard discrete PG* vars are read directly by `pg`:
 *       PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 *
 * Exposes:
 *   - query(text, params)   thin wrapper around pool.query (use parameterized SQL)
 *   - close()               graceful shutdown / test teardown
 *   - initSchema()          applies db/schema.sql (idempotent CREATE ... IF NOT EXISTS)
 *   - healthCheck()         runs `SELECT 1`; resolves true, or throws on failure
 *   - assertConnectivity()  boot-time guard: fails loudly (clear message + non-zero
 *                           exit) when Postgres is unreachable. The caller decides
 *                           WHEN to invoke it (see server.js); it is never run at
 *                           import time.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build the pool config from the environment.
 *   - When DATABASE_URL is set, pass it as `connectionString`.
 *   - Otherwise construct the pool with no explicit connection options so `pg`
 *     reads the standard PG* environment variables (PGHOST, PGPORT, PGUSER,
 *     PGPASSWORD, PGDATABASE) itself.
 * @returns {pg.PoolConfig}
 */
function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  return connectionString ? { connectionString } : {};
}

/** Single shared pool for the whole process. */
export const pool = new pg.Pool(buildPoolConfig());

// Surface pool-level errors on idle clients so a dropped backend connection
// does not crash the process silently.
pool.on("error", (err) => {
  console.error("[db] unexpected error on idle PostgreSQL client:", err.message);
});

/**
 * Thin wrapper around pool.query. Always call with parameterized SQL
 * (`$1, $2, ...`) so untrusted values are passed to Postgres separately from
 * the SQL text.
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a single transaction on a dedicated pooled client.
 *
 * `fn` receives that client so a multi-statement unit of work (e.g. a chunked
 * bulk insert that must not exceed Postgres's per-statement bind-parameter
 * limit) commits atomically — all chunks land or none do. Any throw triggers a
 * ROLLBACK; the client is always released back to the pool.
 *
 * @template T
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; surface the original error below.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Gracefully close the pool (shutdown / test teardown).
 * @returns {Promise<void>}
 */
export async function close() {
  await pool.end();
}

/**
 * Apply the database schema. Reads schema.sql (located relative to this module)
 * and executes it as a single simple-query batch. schema.sql uses
 * CREATE ... IF NOT EXISTS throughout, so this is idempotent and safe to run on
 * every boot and in integration-test setup.
 * @returns {Promise<void>}
 */
export async function initSchema() {
  const schemaPath = join(__dirname, "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

/**
 * Boot-time connectivity probe. Runs `SELECT 1` against the pool.
 * @returns {Promise<true>} resolves true when reachable
 * @throws when the query cannot be executed (Postgres unreachable / misconfigured)
 */
export async function healthCheck() {
  await pool.query("SELECT 1");
  return true;
}

/**
 * Fail-loud boot guard. Verifies connectivity via {@link healthCheck}; on
 * failure it logs a clear, actionable message and exits the process with a
 * non-zero status rather than serving requests against a dead database.
 *
 * This is NOT invoked at import time — the caller (server.js) decides when to
 * run it during startup.
 *
 * @param {{ exitOnFailure?: boolean }} [options]
 *   Set `exitOnFailure: false` to rethrow instead of exiting (useful in tests).
 * @returns {Promise<true>}
 */
export async function assertConnectivity({ exitOnFailure = true } = {}) {
  try {
    await healthCheck();
    return true;
  } catch (err) {
    const target = process.env.DATABASE_URL
      ? "DATABASE_URL"
      : "the PG* environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)";
    console.error(
      `[db] FATAL: cannot reach PostgreSQL. Check ${target}.\n` +
        `[db] underlying error: ${err && err.message ? err.message : err}`
    );
    if (exitOnFailure) {
      process.exit(1);
    }
    throw err;
  }
}
