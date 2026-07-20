/**
 * Driver seeding script (Requirement 10.1).
 *
 * Inserts (or updates) driver rows so a driver can log in to the Driver_View.
 * Each driver row stores a `username`, a scrypt `password_hash`, and an assigned
 * `route_id`. Passwords are NEVER stored in plaintext and NEVER committed here:
 * the plaintext seed password is read from the environment and hashed with
 * `hashPassword` (node:crypto scrypt) before it ever touches the database.
 *
 * Runnable via the package script added in task 1:
 *   npm run db:seed            -> node src/db/seedDrivers.js
 *
 * Environment variables (read at run time):
 *   SEED_DRIVER_USERNAME   local-dev default: "driver1"   (NOT a secret)
 *   SEED_DRIVER_ROUTE_ID   local-dev default: "route-1"   (NOT a secret)
 *   SEED_DRIVER_PASSWORD   REQUIRED in real environments. A non-secret local-dev
 *                          placeholder is used when unset (a warning is logged).
 *   Plus DATABASE_URL / PG* for the connection pool (see src/db/pool.js).
 *
 * NOTE: `hashPassword` lives in ../auth/credentials.js, which is implemented in a
 * later task (8.1). This import resolves once that module lands; until then the
 * script parses/type-checks fine (`node --check`) but cannot be executed.
 */

import { pathToFileURL } from "node:url";
import { hashPassword } from "../auth/credentials.js";
import { query, initSchema, close } from "./pool.js";

/**
 * Build the list of drivers to seed from the environment.
 *
 * Usernames and route assignments are NOT secrets and may carry sensible
 * local-dev defaults. PASSWORDS ARE SECRETS: real passwords must be supplied via
 * `SEED_DRIVER_PASSWORD`. The default below is an obvious, non-secret placeholder
 * intended for local development only.
 *
 * To seed more drivers, extend the returned array (each entry needs a `username`,
 * a `routeId`, and a `password` sourced from the environment).
 *
 * @returns {Array<{ username: string, routeId: string|null, password: string }>}
 */
export function buildSeedDrivers() {
  const username = process.env.SEED_DRIVER_USERNAME || "driver1";
  const routeId = process.env.SEED_DRIVER_ROUTE_ID || "route-1";
  const password = process.env.SEED_DRIVER_PASSWORD || "local-dev-only-change-me";

  if (!process.env.SEED_DRIVER_PASSWORD) {
    console.warn(
      "[seed] SEED_DRIVER_PASSWORD is not set — using a non-secret local-dev " +
        "placeholder. Set SEED_DRIVER_PASSWORD in any real environment."
    );
  }

  return [{ username, routeId, password }];
}

/**
 * Upsert the given drivers. For each driver the plaintext password is hashed
 * (scrypt) and stored as `password_hash`; the row is inserted or, when the
 * username already exists, updated — so re-running the seed is idempotent.
 *
 * Uses a direct PARAMETERIZED `INSERT ... ON CONFLICT (username) DO UPDATE` so
 * untrusted values are never concatenated into SQL. `hashPassword` may be sync
 * or async; `await` handles both.
 *
 * @param {Array<{ username: string, routeId?: string|null, password: string }>} drivers
 * @returns {Promise<number>} number of driver rows upserted
 */
export async function seedDrivers(drivers) {
  let count = 0;
  for (const driver of drivers) {
    const passwordHash = await hashPassword(driver.password);
    await query(
      `INSERT INTO drivers (username, password_hash, route_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         route_id      = EXCLUDED.route_id`,
      [driver.username, passwordHash, driver.routeId ?? null]
    );
    count += 1;
  }
  return count;
}

/**
 * Entry point: ensure the schema exists, seed the configured drivers, then close
 * the pool. Kept separate from the module body so importing this file (e.g. from
 * integration tests) does not trigger any database work.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const drivers = buildSeedDrivers();
  await initSchema();
  const count = await seedDrivers(drivers);
  console.log(
    `[seed] upserted ${count} driver(s): ${drivers.map((d) => d.username).join(", ")}`
  );
  await close();
}

// Run the seeding logic only when executed directly (npm run db:seed), not when
// imported. pathToFileURL makes this comparison correct on Windows too.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error("[seed] failed:", err && err.message ? err.message : err);
    try {
      await close();
    } catch {
      // Ignore secondary errors while shutting down after a failure.
    }
    process.exit(1);
  });
}
