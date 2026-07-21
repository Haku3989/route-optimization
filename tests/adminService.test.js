import test from "node:test";
import assert from "node:assert/strict";

import {
  getSetupStatus,
  setupFirstAdmin,
} from "../src/services/adminService.js";
import { UserError } from "../src/services/userService.js";

// ---------------------------------------------------------------------------
// In-memory repository fake (no database, no network).
// ---------------------------------------------------------------------------

function fakeRepositories({ seedAdmins = [] } = {}) {
  const admins = seedAdmins.map((username, i) => ({ id: i + 1, username }));
  const sessions = [];
  return {
    countAdmins: async () => admins.length,
    createAdmin: async (username, passwordHash) => {
      if (admins.some((a) => a.username === username)) return null;
      const row = { id: admins.length + 1, username };
      admins.push(row);
      return row;
    },
    insertAdminSession: async (token, adminId) => {
      sessions.push({ token, adminId });
    },
    _admins: admins,
    _sessions: sessions,
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
