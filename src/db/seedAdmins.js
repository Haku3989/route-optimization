/**
 * Admin seeding script.
 *
 * Inserts (or updates) an admin row so an administrator can sign in to the
 * admin portal (public/admin.html). Mirrors seedDrivers.js: the plaintext seed
 * password is read from the environment and hashed with `hashPassword`
 * (node:crypto scrypt) before it ever touches the database. Passwords are NEVER
 * stored in plaintext and NEVER committed here.
 *
 * Runnable via the package script:
 *   npm run db:seed:admin      -> node src/db/seedAdmins.js
 *
 * Environment variables (read at run time):
 *   SEED_ADMIN_USERNAME   local-dev default: "admin"   (NOT a secret)
 *   SEED_ADMIN_PASSWORD   REQUIRED in real environments. A non-secret local-dev
 *                         placeholder is used when unset (a warning is logged).
 *   Plus DATABASE_URL / PG* for the connection pool (see src/db/pool.js).
 */

import { pathToFileURL } from "node:url";
import { hashPassword } from "../auth/credentials.js";
import { query, initSchema, close } from "./pool.js";

/**
 * Build the list of admins to seed from the environment.
 *
 * The username is not a secret and carries a sensible local-dev default.
 * PASSWORDS ARE SECRETS: a real password must be supplied via
 * `SEED_ADMIN_PASSWORD`. The default below is an obvious, non-secret
 * placeholder intended for local development only.
 *
 * @returns {Array<{ username: string, password: string }>}
 */
export function buildSeedAdmins() {
  const username = process.env.SEED_ADMIN_USERNAME || "admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "local-dev-only-change-me";

  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn(
      "[seed] SEED_ADMIN_PASSWORD is not set — using a non-secret local-dev " +
        "placeholder. Set SEED_ADMIN_PASSWORD in any real environment."
    );
  }

  return [{ username, password }];
}

/**
 * Upsert the given admins. For each admin the plaintext password is hashed
 * (scrypt) and stored as `password_hash`; the row is inserted or, when the
 * username already exists, updated — so re-running the seed is idempotent.
 *
 * @param {Array<{ username: string, password: string }>} admins
 * @returns {Promise<number>} number of admin rows upserted
 */
export async function seedAdmins(admins) {
  let count = 0;
  for (const admin of admins) {
    const passwordHash = await hashPassword(admin.password);
    await query(
      `INSERT INTO admins (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash`,
      [admin.username, passwordHash]
    );
    count += 1;
  }
  return count;
}

/**
 * Entry point: ensure the schema exists, seed the configured admins, then close
 * the pool. Kept separate from the module body so importing this file does not
 * trigger any database work.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const admins = buildSeedAdmins();
  await initSchema();
  const count = await seedAdmins(admins);
  console.log(
    `[seed] upserted ${count} admin(s): ${admins.map((a) => a.username).join(", ")}`
  );
  await close();
}

// Run the seeding logic only when executed directly (npm run db:seed:admin),
// not when imported. pathToFileURL makes this comparison correct on Windows too.
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
