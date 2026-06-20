import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  decryptWithKey,
  encrypt,
  encryptWithKey,
} from "#shared/crypto/encryption.ts";
import { hashPassword, hmacHash } from "#shared/crypto/hashing.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  unwrapKey,
  wrapKey,
} from "#shared/crypto/keys.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  activateUser,
  createInvitedUser,
  getUserByUsername,
  hashInviteCode,
  hasPassword,
  invalidateUsersCache,
  setUserPassword,
  verifyUserPassword,
} from "#shared/db/users.ts";
import type { User } from "#shared/types.ts";
import {
  createTestInvite,
  describeWithEnv,
  mockAdminLoginRequest,
  mockFormRequest,
  submitJoinForm,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

/** Unwrap the shared owner DATA_KEY (created at v2 by setup). */
const ownerDataKey = async (): Promise<CryptoKey> => {
  const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
  return unwrapKey(
    owner.wrapped_data_key!,
    await deriveKEKFromPassword(TEST_ADMIN_PASSWORD),
  );
};

/** Seed a legacy (v1) manager that shares the owner DATA_KEY, wrapped with the
 * hash-derived KEK and kek_version left at 1 — the shape login must migrate. */
const seedV1User = async (
  username: string,
  password: string,
): Promise<User> => {
  const dataKey = await ownerDataKey();
  const passwordHash = await hashPassword(password);
  const wrapped = await wrapKey(dataKey, await deriveKEK(passwordHash));
  await getDb().execute(
    insert("users", {
      admin_level: await encrypt("manager"),
      kek_version: 1,
      password_hash: await encrypt(passwordHash),
      username_hash: await encrypt(username),
      username_index: await hmacHash(username),
      wrapped_data_key: wrapped,
    }),
  );
  invalidateUsersCache();
  return (await getUserByUsername(username))!;
};

/** Whether the owner DATA_KEY and the given user's data key are the same key. */
const sharesOwnerDataKey = async (userDataKey: CryptoKey): Promise<boolean> => {
  const sealed = await encryptWithKey("shared-secret", await ownerDataKey());
  return (await decryptWithKey(sealed, userDataKey)) === "shared-secret";
};

describeWithEnv("KEK v2 (password-bound DATA_KEY)", { db: true }, () => {
  describe("invite self-activation (handoff)", () => {
    test("a routed invite carries a key handoff and no wrapped key yet", async () => {
      await createTestInvite("handoff-pending");
      const invited = (await getUserByUsername("handoff-pending"))!;
      expect(invited.invite_wrapped_data_key).not.toBeNull();
      expect(invited.wrapped_data_key).toBeNull();
      expect(invited.kek_version).toBe(1);
    });

    test("joining self-activates the user at v2 with the shared DATA_KEY", async () => {
      const { inviteCode } = await createTestInvite("handoff-join");
      await submitJoinForm(inviteCode, {
        password: "joinerpass123",
        password_confirm: "joinerpass123",
      });

      const activated = (await getUserByUsername("handoff-join"))!;
      expect(activated.wrapped_data_key).not.toBeNull();
      expect(activated.invite_wrapped_data_key).toBeNull();
      expect(activated.kek_version).toBe(2);

      const dataKey = await unwrapKey(
        activated.wrapped_data_key!,
        await deriveKEKFromPassword("joinerpass123"),
      );
      expect(await sharesOwnerDataKey(dataKey)).toBe(true);
    });

    test("a self-activated user can log in without admin activation", async () => {
      const { inviteCode } = await createTestInvite("handoff-login");
      await submitJoinForm(inviteCode, {
        password: "joinerpass123",
        password_confirm: "joinerpass123",
      });

      const response = await handleRequest(
        await mockAdminLoginRequest({
          password: "joinerpass123",
          username: "handoff-login",
        }),
      );
      const cookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${getSessionCookieName()}=`));
      expect(cookie).toBeDefined();
    });

    test("the invite is rejected when the owner session has no data key", async () => {
      const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
      await createSession(
        "no-key-token",
        "csrf-nokey",
        Date.now() + 60_000,
        null,
        owner.id,
      );
      const csrfToken = await signCsrfToken();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            admin_level: "manager",
            csrf_token: csrfToken,
            username: "guarded",
          },
          `${getSessionCookieName()}=no-key-token`,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/user/new");
      expect(await getUserByUsername("guarded")).toBeNull();
    });
  });

  describe("legacy invite (no key handoff)", () => {
    test("joining sets the password but leaves the key to admin activation", async () => {
      const expiry = new Date(Date.now() + 600_000).toISOString();
      await createInvitedUser(
        "legacy-join",
        "manager",
        await hashInviteCode("legacy-join-code"),
        expiry,
      );

      await submitJoinForm("legacy-join-code", {
        password: "legacypass123",
        password_confirm: "legacypass123",
      });

      const user = (await getUserByUsername("legacy-join"))!;
      expect(user.wrapped_data_key).toBeNull();
      expect(await hasPassword(user)).toBe(true);
    });

    test("admin activation provisions a legacy v1 wrap", async () => {
      const expiry = new Date(Date.now() + 600_000).toISOString();
      await createInvitedUser(
        "legacy-activate",
        "manager",
        await hashInviteCode("legacy-activate-code"),
        expiry,
      );
      const hash = await setUserPassword(
        (await getUserByUsername("legacy-activate"))!.id,
        "legacypass123",
      );

      await activateUser(
        (await getUserByUsername("legacy-activate"))!.id,
        await ownerDataKey(),
        hash,
      );

      const user = (await getUserByUsername("legacy-activate"))!;
      expect(user.wrapped_data_key).not.toBeNull();
      expect(user.kek_version).toBe(1);
      // Legacy wrap unwraps with the hash-derived (v1) KEK.
      const dataKey = await unwrapKey(
        user.wrapped_data_key!,
        await deriveKEK(hash),
      );
      expect(await sharesOwnerDataKey(dataKey)).toBe(true);
    });
  });

  describe("login migrates a legacy v1 user to v2", () => {
    test("first login re-wraps the DATA_KEY under the password", async () => {
      const seeded = await seedV1User("v1-login", "v1pass12345");
      expect(seeded.kek_version).toBe(1);
      const oldWrap = seeded.wrapped_data_key;

      await handleRequest(
        await mockAdminLoginRequest({
          password: "v1pass12345",
          username: "v1-login",
        }),
      );

      const migrated = (await getUserByUsername("v1-login"))!;
      expect(migrated.kek_version).toBe(2);
      expect(migrated.wrapped_data_key).not.toBe(oldWrap);
      const dataKey = await unwrapKey(
        migrated.wrapped_data_key!,
        await deriveKEKFromPassword("v1pass12345"),
      );
      expect(await sharesOwnerDataKey(dataKey)).toBe(true);
    });
  });

  describe("password change", () => {
    test("changing a legacy v1 user's password re-wraps at v2", async () => {
      const user = await seedV1User("v1-pwchange", "v1pass12345");
      const oldHash = await verifyUserPassword(user, "v1pass12345");

      const ok = await settings.updateUserPassword(user.id, {
        newPassword: "brandnew12345",
        oldKekVersion: user.kek_version,
        oldPassword: "v1pass12345",
        oldPasswordHash: oldHash!,
        oldWrappedDataKey: user.wrapped_data_key!,
      });
      expect(ok).toBe(true);

      const updated = (await getUserByUsername("v1-pwchange"))!;
      expect(updated.kek_version).toBe(2);
      const dataKey = await unwrapKey(
        updated.wrapped_data_key!,
        await deriveKEKFromPassword("brandnew12345"),
      );
      expect(await sharesOwnerDataKey(dataKey)).toBe(true);
    });
  });

  describe("security property", () => {
    test("a v2 wrap cannot be unwrapped with the DB-recoverable v1 KEK", async () => {
      const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
      const hash = (await verifyUserPassword(owner, TEST_ADMIN_PASSWORD))!;

      // The v1 KEK from the stored (DB-recoverable) hash must NOT unwrap the v2
      // wrap — only the raw password's KEK does.
      await expect(
        unwrapKey(owner.wrapped_data_key!, await deriveKEK(hash)),
      ).rejects.toThrow();

      const dataKey = await unwrapKey(
        owner.wrapped_data_key!,
        await deriveKEKFromPassword(TEST_ADMIN_PASSWORD),
      );
      expect(dataKey).toBeDefined();
    });
  });
});
