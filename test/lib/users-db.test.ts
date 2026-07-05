import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { hashPassword, hmacHash } from "#shared/crypto/hashing.ts";
import { getDb, insert } from "#shared/db/client.ts";
import {
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  getAllUsers,
  getUserByUsername,
  invalidateUsersCache,
  isInviteExpired,
  isInviteValid,
  verifyUserPassword,
} from "#shared/db/users.ts";
import {
  assertAdminPasswordRejects,
  assertAdminPasswordVerifies,
  describeWithEnv,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("users CRUD", () => {
    test("createTestDbWithSetup creates the owner user", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(1);
      expect(user!.wrapped_data_key).not.toBeNull();

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
      expect(user.password_hash).toBe("");
      expect(user.wrapped_data_key).toBeNull();

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
        "UPDATE users SET invite_code_hash = ? WHERE id = ?",
        [await encrypt(""), user.id],
      );

      const { getUserById: getUser } = await import("#shared/db/users.ts");
      const updatedUser = await getUser(user.id);
      const valid = await isInviteValid(updatedUser!);
      expect(valid).toBe(false);
    });

    test("isInviteValid returns false when invite_expiry is null", async () => {
      const usernameIdx = await hmacHash("no-expiry-user");
      await getDb().execute(
        insert("users", {
          admin_level: await encrypt("manager"),
          invite_code_hash: await encrypt("somehash"),
          invite_expiry: null,
          password_hash: "",
          username_hash: await encrypt("no-expiry-user"),
          username_index: usernameIdx,
          wrapped_data_key: null,
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
        insert("users", {
          admin_level: await encrypt("superadmin"),
          invite_code_hash: null,
          invite_expiry: null,
          password_hash: "",
          username_hash: await encrypt("badlevel-user"),
          username_index: usernameIdx,
          wrapped_data_key: null,
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
        insert("users", {
          admin_level: await encrypt("manager"),
          invite_code_hash: await encrypt("somehash"),
          invite_expiry: await encrypt(""),
          password_hash: "",
          username_hash: await encrypt("empty-expiry-user"),
          username_index: usernameIdx,
          wrapped_data_key: null,
        }),
      );
      invalidateUsersCache();

      const user = await getUserByUsername("empty-expiry-user");
      const valid = await isInviteValid(user!);
      expect(valid).toBe(false);
    });
  });
});
