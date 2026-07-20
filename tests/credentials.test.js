import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  hashPassword,
  verifyPassword,
  newToken,
  AuthError,
  GENERIC_AUTH_MESSAGE,
} from "../src/auth/credentials.js";

// --- Generators -------------------------------------------------------------
// Passwords span ASCII, unicode/Thai, and the empty string so the crypto layer
// is exercised across the realistic input space (never mocked).
const passwordArb = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.constantFrom("", " ", "p@ssw0rd", "ร้านสมชาย123", "😀🔐", "a".repeat(200))
);

// Stored strings that are NOT a valid "scrypt$<saltHex>$<hashHex>" encoding.
// verifyPassword must return false (never throw) for every one of these.
const malformedStoredArb = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    "   ",
    "plain",
    "scrypt",
    "scrypt$",
    "scrypt$$",
    "scrypt$deadbeef",
    "scrypt$deadbeef$",
    "scrypt$deadbeef$oddlen1", // hash segment is not valid hex
    "scrypt$xyz$deadbeef", // salt segment is not hex
    "scrypt$deadbee$deadbeef", // salt segment is odd length
    "$deadbeef$deadbeef", // empty scheme
    "md5$deadbeef$deadbeef", // wrong scheme
    "scrypt$deadbeef$deadbeef$extra", // too many parts
    "scrypt$deadbeef$deadbeef" // well-formed shape but wrong salt/hash -> mismatch
  )
);

// --- Property 21 (hashing half) ---------------------------------------------
// Feature: excel-route-planning, Property 21: Password hashing round-trips and valid login issues a resolvable token
// Validates: Requirements 10.1
test("Property 21 (hashing half): password hashing round-trips and salts are unique", () => {
  fc.assert(
    fc.property(passwordArb, passwordArb, (pw, other) => {
      const stored = hashPassword(pw);

      // Shape: self-describing "scrypt$<saltHex>$<hashHex>".
      const parts = stored.split("$");
      assert.equal(parts.length, 3);
      assert.equal(parts[0], "scrypt");

      // Round-trip: the password verifies against its own hash.
      assert.equal(verifyPassword(pw, stored), true);

      // A different password does NOT verify against that hash.
      if (other !== pw) {
        assert.equal(verifyPassword(other, stored), false);
      }

      // Random per-call salt: two hashes of the same password differ, yet each
      // still verifies (proving the difference is the salt, not the password).
      const stored2 = hashPassword(pw);
      assert.notEqual(stored, stored2);
      assert.equal(verifyPassword(pw, stored2), true);
    }),
    { numRuns: 100 }
  );
});

// --- Property 22 ------------------------------------------------------------
// Feature: excel-route-planning, Property 22: Invalid credentials are denied with a single generic error
// Validates: Requirements 10.2
test("Property 22: wrong passwords are denied by verifyPassword", () => {
  fc.assert(
    fc.property(passwordArb, passwordArb, (realPw, attempt) => {
      const stored = hashPassword(realPw);
      if (attempt === realPw) {
        assert.equal(verifyPassword(attempt, stored), true);
      } else {
        assert.equal(verifyPassword(attempt, stored), false);
      }
    }),
    { numRuns: 100 }
  );
});

// Feature: excel-route-planning, Property 22: Invalid credentials are denied with a single generic error
// Validates: Requirements 10.2
test("Property 22: malformed stored hashes verify as false and never throw", () => {
  fc.assert(
    fc.property(passwordArb, malformedStoredArb, (pw, stored) => {
      assert.equal(verifyPassword(pw, stored), false);
    }),
    { numRuns: 100 }
  );
});

// --- Property 22: the denial error is a single generic message --------------
// Feature: excel-route-planning, Property 22: Invalid credentials are denied with a single generic error
// Validates: Requirements 10.2
test("Property 22: AuthError carries one generic message that hides which field was wrong", () => {
  const unknownUser = new AuthError();
  const badPassword = new AuthError();

  // Identical, generic message regardless of the underlying failure cause.
  assert.equal(unknownUser.message, GENERIC_AUTH_MESSAGE);
  assert.equal(badPassword.message, GENERIC_AUTH_MESSAGE);
  assert.equal(unknownUser.message, badPassword.message);

  // 401 status for route translation, and it is a real Error subclass.
  assert.equal(unknownUser.status, 401);
  assert.equal(unknownUser.name, "AuthError");
  assert.ok(unknownUser instanceof Error);

  // The message names both fields together (revealing neither individually).
  assert.match(unknownUser.message, /username/);
  assert.match(unknownUser.message, /password/);
});

// --- Example tests ----------------------------------------------------------

test("verifyPassword returns false for non-string stored values", () => {
  const stored = hashPassword("secret");
  assert.equal(verifyPassword("secret", stored), true);
  for (const bad of [null, undefined, 123, {}, [], true]) {
    assert.equal(verifyPassword("secret", bad), false);
  }
});

test("newToken returns a fresh 32-byte (64 hex char) token each call", () => {
  const a = newToken();
  const b = newToken();
  assert.equal(typeof a, "string");
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
