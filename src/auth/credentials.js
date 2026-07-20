/**
 * Pure credential/token helpers for driver authentication (Requirement 10.1, 10.2).
 *
 * This module intentionally has NO database dependency so it stays pure and
 * property-testable. It uses Node's built-in `node:crypto` only:
 *   - `hashPassword` derives a scrypt hash with a per-user random salt and
 *     encodes it as a self-describing "scrypt$<saltHex>$<hashHex>" string, so a
 *     password is NEVER stored in plaintext.
 *   - `verifyPassword` re-derives the hash from the stored salt and compares it
 *     with `crypto.timingSafeEqual` (constant-time) to avoid leaking timing
 *     information; it returns `false` (never throws) on malformed input.
 *   - `newToken` mints an opaque random bearer token for a driver session.
 *
 * `AuthError` (and the shared generic denial message) live in `./errors.js` and
 * are re-exported here so callers can import everything auth-related from one
 * place while routes can still import the error type without `node:crypto`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export { AuthError, GENERIC_AUTH_MESSAGE } from "./errors.js";

// scrypt parameters. The salt length and derived-key length are fixed here;
// scrypt's work factor uses Node's secure defaults (N=16384, r=8, p=1).
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCHEME = "scrypt";

/** True when `value` is an even-length string of hex digits. */
function isHex(value) {
  return typeof value === "string" && value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Hash a plaintext password with scrypt and a fresh random salt.
 *
 * The returned string is self-describing so `verifyPassword` needs nothing
 * else to check it later: `"scrypt$<saltHex>$<hashHex>"`. Because the salt is
 * random per call, hashing the same password twice yields two different
 * strings.
 *
 * @param {string} plain the plaintext password
 * @returns {string} encoded hash "scrypt$<saltHex>$<hashHex>"
 */
export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(String(plain), salt, KEY_BYTES);
  return `${SCHEME}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored "scrypt$<saltHex>$<hashHex>"
 * string using a constant-time comparison.
 *
 * Returns `false` (never throws) for any malformed stored value: wrong scheme,
 * missing parts, non-hex/odd-length segments, or a non-string input. This keeps
 * the caller's control flow identical for "wrong password" and "corrupt record",
 * so neither timing nor exceptions reveal which case occurred.
 *
 * @param {string} plain  the plaintext password to check
 * @param {string} stored the encoded hash produced by `hashPassword`
 * @returns {boolean} true only when `plain` matches the stored hash
 */
export function verifyPassword(plain, stored) {
  if (typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 3) return false;

  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== SCHEME || !isHex(saltHex) || !isHex(hashHex)) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = scryptSync(String(plain), salt, expected.length);
  } catch {
    // scrypt can reject pathological key lengths / memory limits; treat any
    // such failure as a non-match rather than surfacing an error.
    return false;
  }

  // Lengths are equal by construction (actual derived at expected.length), so
  // timingSafeEqual will not throw; the guard is belt-and-suspenders.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Mint a new opaque bearer token: 32 random bytes rendered as a 64-char hex
 * string. Used as the primary key of a persisted driver session.
 *
 * @returns {string} 64-character hex token
 */
export function newToken() {
  return randomBytes(32).toString("hex");
}
