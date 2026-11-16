import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { hashPassword, hmacHash } from "#crypto/hashing.ts";
import { execute, getDb } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import {
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  getAllUsers,
  getUserAuthFieldsById,
  getUserByUsername,
  invalidateUsersCache,
  isInviteExpired,
  isInviteValid,
  verifyUserPassword,
} from "#db/users.ts";
import { insertInto } from "#db/write.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assertAdminPasswordRejects,
  assertAdminPasswordVerifies,
} from "#test-utils/db-helpers/misc.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("users CRUD", () => {
    test("reads authentication fields fresh for every authorization", async () => {
      const queries: string[] = [];
      const restore = recordQueries(queries);
      try {
        const before = await getUserAuthFieldsById(1);
        expect(await decryptAdminLevel(before!)).toBe("owner");
        await execute(
          sql`UPDATE users SET admin_level = ${await encrypt("manager")} WHERE id = ${1}`,
        );
        const after = await getUserAuthFieldsById(1);
        expect(await decryptAdminLevel(after!)).toBe("manager");
      } finally {
        restore();
      }
      expect(
        queries.filter((sql) =>
          sql.includes("FROM users AS user WHERE user.id = "),
        ),
      ).toEqual([
        "SELECT user.id AS id, user.admin_level AS admin_level FROM users AS user WHERE user.id = ?1 LIMIT ?1",
        "SELECT user.id AS id, user.admin_level AS admin_level FROM users AS user WHERE user.id = ?1 LIMIT ?1",
      ]);
    });

    test("createTestDbWithSetup creates the owner user", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(1);
      expect(user!.wrappedDataKey).not.toBeNull();

      const level = await decryptAdminLevel(user!);
      expect(level).toBe("owner");

      const username = await decryptUsername(user!);
      expect(username).toBe(TEST_ADMIN_USERNAME);
    });

    test("verifyUserPassword returns hash for correct password", () =>
      assertAdminPasswordVerifies());

    test("verifyUserPassword returns null for wrong password", () =>
      assertAdminPasswordRejects());

    test("getUserByUsername returns null for nonexistent user", async () => {
      const user = await getUserByUsername("nonexistent");
      expect(user).toBeNull();
    });

    test("getAllUsers returns all users", async () => {
      const users = await getAllUsers();
      expect(users.length).toBe(1);
      expect(users[0]!.id).toBe(1);
    });
  });

  describe("invited users", () => {
    test("createInvitedUser creates user with invite code", async () => {
      const inviteHash = await hashPassword("invite123");
      const expiry = new Date(Date.now() + 86400000).toISOString();

      const user = await createInvitedUser(
        "invitee",
        "manager",
        inviteHash,
        expiry,
      );

      expect(user.id).toBe(2);
      expect(user.passwordHash).toBe("");
      expect(user.wrappedDataKey).toBeNull();

      const level = await decryptAdminLevel(user);
      expect(level).toBe("manager");

      const username = await decryptUsername(user);
      expect(username).toBe("invitee");
    });

    test("isInviteValid returns true for valid invite", async () => {
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const user = await createInvitedUser(
        "invitee",
        "manager",
        "somehash",
        expiry,
      );

      const valid = await isInviteValid(user);
      expect(valid).toBe(true);
    });

    test("isInviteValid returns false for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const user = await createInvitedUser(
        "expired-user",
        "manager",
        "somehash",
        expiry,
      );

      const valid = await isInviteValid(user);
      expect(valid).toBe(false);
    });
  });

  describe("isInviteExpired", () => {
    test("returns true for expired invite", async () => {
      const expiry = new Date(Date.now() - 1000).toISOString();
      const user = await createInvitedUser(
        "expired-check",
        "manager",
        "somehash",
        expiry,
      );

      expect(await isInviteExpired(user)).toBe(true);
    });

    test("returns false for valid invite", async () => {
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const user = await createInvitedUser(
        "valid-check",
        "manager",
        "somehash",
        expiry,
      );

      expect(await isInviteExpired(user)).toBe(false);
    });

    test("returns false for user without invite code", async () => {
      const owner = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(await isInviteExpired(owner!)).toBe(false);
    });
  });

  describe("db/users.ts edge cases", () => {
    test("verifyUserPassword returns null when user has empty password_hash", async () => {
      const user = await createInvitedUser(
        "nopwd",
        "manager",
        "hash",
        new Date(Date.now() + 86400000).toISOString(),
      );
      const result = await verifyUserPassword(user, "anypassword");
      expect(result).toBeNull();
    });

    test("isInviteValid returns false when invite_code_hash is null", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite was already used (empty decrypted hash)", async () => {
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const user = await createInvitedUser(
        "used-invite",
        "manager",
        "somehash",
        expiry,
      );

      // Accepting an invite clears its code to an encrypted empty string.
      await getDb().execute(
        sql`UPDATE users SET invite_code_hash = ${await encrypt("")} WHERE id = ${user.id}`,
      );

      const { getUserById: getUser } = await import("#db/users.ts");
      const updatedUser = await getUser(user.id);
      const valid = await isInviteValid(updatedUser!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry is null", async () => {
      const usernameIdx = await hmacHash("no-expiry-user");
      await getDb().execute(
        insertInto(tables.users, {
          adminLevel: await encrypt("manager"),
          inviteCodeHash: await encrypt("somehash"),
          inviteExpiry: null,
          passwordHash: "",
          usernameHash: await encrypt("no-expiry-user"),
          usernameIndex: usernameIdx,
          wrappedDataKey: null,
        }),
      );
      invalidateUsersCache();

      const user = await getUserByUsername("no-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });

    test("decryptAdminLevel throws when admin_level decrypts to invalid value", async () => {
      const usernameIdx = await hmacHash("badlevel-user");
      await getDb().execute(
        insertInto(tables.users, {
          adminLevel: await encrypt("superadmin"),
          inviteCodeHash: null,
          inviteExpiry: null,
          passwordHash: "",
          usernameHash: await encrypt("badlevel-user"),
          usernameIndex: usernameIdx,
          wrappedDataKey: null,
        }),
      );
      invalidateUsersCache();

      const user = await getUserByUsername("badlevel-user");
      await expect(decryptAdminLevel(user!)).rejects.toThrow(
        "Invalid admin level",
      );
    });

    test("isInviteValid returns false when invite_expiry decrypts to empty string", async () => {
      const usernameIdx = await hmacHash("empty-expiry-user");
      await getDb().execute(
        insertInto(tables.users, {
          adminLevel: await encrypt("manager"),
          inviteCodeHash: await encrypt("somehash"),
          inviteExpiry: await encrypt(""),
          passwordHash: "",
          usernameHash: await encrypt("empty-expiry-user"),
          usernameIndex: usernameIdx,
          wrappedDataKey: null,
        }),
      );
      invalidateUsersCache();

      const user = await getUserByUsername("empty-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });
  });
});
