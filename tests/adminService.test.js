import test from "node:test";
import assert from "node:assert/strict";

import {
  getSetupStatus,
  setupFirstAdmin,
  login,
  resolveSession,
  logout,
} from "../src/services/adminService.js";
import { UserError } from "../src/services/userService.js";
import { AuthError } from "../src/auth/credentials.js";

// ---------------------------------------------------------------------------
// In-memory repository fake (no database, no network). Tracks every call so
// tests can prove the master-admin path never touches it.
// ---------------------------------------------------------------------------

function fakeRepositories({ seedAdmins = [] } = {}) {
  const admins = seedAdmins.map((username, i) => ({ id: i + 1, username }));
  const sessions = [];
  const calls = [];
  return {
    countAdmins: async () => {
      calls.push("countAdmins");
      return admins.length;
    },
    createAdmin: async (username, passwordHash) => {
      calls.push("createAdmin");
      if (admins.some((a) => a.username === username)) return null;
      const row = { id: admins.length + 1, username };
      admins.push(row);
      return row;
    },
    insertAdminSession: async (token, adminId) => {
      calls.push("insertAdminSession");
      sessions.push({ token, adminId });
    },
    findAdminByUsername: async (username) => {
      calls.push("findAdminByUsername");
      return admins.find((a) => a.username === username) ?? null;
    },
    findAdminSession: async (token) => {
      calls.push("findAdminSession");
      return sessions.find((s) => s.token === token) ?? null;
    },
    deleteAdminSession: async (token) => {
      calls.push("deleteAdminSession");
      const i = sessions.findIndex((s) => s.token === token);
      if (i >= 0) sessions.splice(i, 1);
    },
    _admins: admins,
    _sessions: sessions,
    _calls: calls,
  };
}

const fakeToken = { newToken: () => "test-token-123" };

// ---------------------------------------------------------------------------
// getSetupStatus
// ---------------------------------------------------------------------------

test("getSetupStatus: needsSetup is true when no admin exists yet", async () => {
  const repositories = fakeRepositories();
  const result = await getSetupStatus({ repositories });
  assert.deepEqual(result, { needsSetup: true });
});

test("getSetupStatus: needsSetup is false once an admin exists", async () => {
  const repositories = fakeRepositories({ seedAdmins: ["admin"] });
  const result = await getSetupStatus({ repositories });
  assert.deepEqual(result, { needsSetup: false });
});

// ---------------------------------------------------------------------------
// setupFirstAdmin
// ---------------------------------------------------------------------------

test("setupFirstAdmin: creates the first admin and signs them in when none exists", async () => {
  const repositories = fakeRepositories();
  const result = await setupFirstAdmin("bootstrap-admin", "a-strong-password", {
    repositories,
    ...fakeToken,
  });

  assert.deepEqual(result, { token: "test-token-123", username: "bootstrap-admin" });
  assert.equal(repositories._admins.length, 1);
  assert.equal(repositories._admins[0].username, "bootstrap-admin");
  assert.equal(repositories._sessions.length, 1);
  assert.equal(repositories._sessions[0].adminId, repositories._admins[0].id);
});

test("setupFirstAdmin: rejected once an admin already exists, regardless of input", async () => {
  const repositories = fakeRepositories({ seedAdmins: ["existing-admin"] });

  await assert.rejects(
    setupFirstAdmin("someone-else", "a-strong-password", { repositories, ...fakeToken }),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.equal(err.status, 409);
      return true;
    }
  );
  // No second admin was created, no stray session was minted.
  assert.equal(repositories._admins.length, 1);
  assert.equal(repositories._sessions.length, 0);
});

test("setupFirstAdmin: reuses createUser's validation (rejects a too-short password)", async () => {
  const repositories = fakeRepositories();

  await assert.rejects(
    setupFirstAdmin("bootstrap-admin", "short", { repositories, ...fakeToken }),
    (err) => {
      assert.ok(err instanceof UserError);
      return true;
    }
  );
  assert.equal(repositories._admins.length, 0);
});

// ---------------------------------------------------------------------------
// Master admin credential (embedded in source at explicit user request) —
// works with NO admin row in the database and never touches the repository
// for the correct credential.
// ---------------------------------------------------------------------------

test("login: the master admin credential succeeds without touching the database at all", async () => {
  const repositories = fakeRepositories(); // zero admins — an empty/unseeded DB
  const result = await login("admin", "AdminFH2026!", { repositories, ...fakeToken });

  assert.deepEqual(result, { token: "test-token-123", username: "admin" });
  assert.deepEqual(repositories._calls, []); // proves the DB was never queried
});

test("login: a wrong password for 'admin' falls through to the normal (DB) path and fails", async () => {
  const repositories = fakeRepositories(); // no DB admin named 'admin' either
  await assert.rejects(
    login("admin", "wrong-password", { repositories, ...fakeToken }),
    (err) => {
      assert.ok(err instanceof AuthError);
      return true;
    }
  );
  // Fell through to the real lookup (and found nothing).
  assert.deepEqual(repositories._calls, ["findAdminByUsername"]);
});

test("login: a real DB admin named 'admin' still works with their OWN password", async () => {
  const repositories = fakeRepositories({ seedAdmins: ["admin"] });
  repositories._admins[0].passwordHash = "seeded-hash";
  // The seeded admin's password hash isn't the master one, so a wrong-for-master
  // password correctly falls through and is checked for real — using the DI'd
  // verifyPassword (matched against the SEEDED hash specifically) so this test
  // never depends on a real scrypt hash and can't accidentally pass via the
  // master-credential branch.
  const result = await login("admin", "the-real-password", {
    repositories,
    ...fakeToken,
    verifyPassword: (plain, stored) => stored === "seeded-hash" && plain === "the-real-password",
  });
  assert.deepEqual(result, { token: "test-token-123", username: "admin" });
  assert.ok(repositories._calls.includes("insertAdminSession"));
});

test("resolveSession: a master-admin token resolves in-memory without touching the database", async () => {
  const repositories = fakeRepositories();
  const { token } = await login("admin", "AdminFH2026!", { repositories, ...fakeToken });

  const session = await resolveSession(token, { repositories });
  assert.deepEqual(session, { adminId: null, username: "admin" });
  assert.deepEqual(repositories._calls, []); // still never touched the DB
});

test("logout: clears a master-admin token in-memory without touching the database", async () => {
  const repositories = fakeRepositories();
  const { token } = await login("admin", "AdminFH2026!", { repositories, ...fakeToken });

  await logout(token, { repositories });
  assert.deepEqual(repositories._calls, []); // logout also never touched the DB

  const session = await resolveSession(token, { repositories });
  assert.equal(session, null); // the token no longer resolves after logout
});
