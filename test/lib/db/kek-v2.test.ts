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
  wrapKeyWithToken,
} from "#shared/crypto/keys.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb, insert } from "#shared/db/client.ts";
import { createSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  acceptInvite,
  createInvitedUser,
  getUserByUsername,
  hashInviteCode,
  invalidateUsersCache,
  pruneExpiredInvites,
  verifyUserPassword,
} from "#shared/db/users.ts";
import type { User } from "#shared/types.ts";
import {
  createTestInvite,
  describeWithEnv,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
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

    test("acceptInvite is single-use: a replay cannot overwrite the account", async () => {
      const { inviteCode } = await createTestInvite("single-use");
      const invited = (await getUserByUsername("single-use"))!;
      const handoff = invited.invite_wrapped_data_key!;

      // First accept consumes the invite and sets the password.
      expect(
        await acceptInvite(invited.id, handoff, inviteCode, "firstpass123"),
      ).toBe(true);
      const wrapAfterFirst = (await getUserByUsername("single-use"))!
        .wrapped_data_key;

      // Replaying with the same (now-stale) handoff must not overwrite.
      expect(
        await acceptInvite(invited.id, handoff, inviteCode, "attacker9999"),
      ).toBe(false);

      const after = (await getUserByUsername("single-use"))!;
      expect(after.wrapped_data_key).toBe(wrapAfterFirst);
      // The first password still works; the replay's password never took.
      expect(await verifyUserPassword(after, "firstpass123")).not.toBeNull();
      expect(await verifyUserPassword(after, "attacker9999")).toBeNull();
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
    test("a pre-handoff invite cannot self-activate and is rejected at /join", async () => {
      await createInvitedUser(
        "legacy-join",
        "manager",
        await hashInviteCode("legacy-join-code"),
        new Date(Date.now() + 600_000).toISOString(),
      );

      // No invite_wrapped_data_key handoff → /join treats it as invalid.
      const response = await handleRequest(
        mockRequest("/join/legacy-join-code"),
      );
      expect(response.status).toBe(404);
      expect(
        (await getUserByUsername("legacy-join"))!.wrapped_data_key,
      ).toBeNull();
    });
  });

  describe("pruneExpiredInvites clears stale handoffs", () => {
    test("deletes expired un-activated invites and keeps valid ones", async () => {
      const dataKey = await ownerDataKey();
      await createInvitedUser(
        "expired-invitee",
        "manager",
        await hashInviteCode("expired-code"),
        new Date(Date.now() - 1000).toISOString(),
        await wrapKeyWithToken(dataKey, "expired-code"),
      );
      await createInvitedUser(
        "valid-invitee",
        "manager",
        await hashInviteCode("valid-code"),
        new Date(Date.now() + 600_000).toISOString(),
        await wrapKeyWithToken(dataKey, "valid-code"),
      );

      const pruned = await pruneExpiredInvites();
      expect(pruned).toBe(1);
      // The expired invite (and its DATA_KEY handoff) is gone; the valid one
      // remains so the invitee can still join.
      expect(await getUserByUsername("expired-invitee")).toBeNull();
      expect(await getUserByUsername("valid-invitee")).not.toBeNull();
    });

    test("never deletes a user that has a password set, even with an expired invite", async () => {
      const dataKey = await ownerDataKey();
      // Worst case: no DATA_KEY wrap, but a password IS set, plus an already-
      // expired invite_expiry and a handoff. The password guard must keep it —
      // the prune must never touch an account that has been set up.
      await getDb().execute(
        insert("users", {
          admin_level: await encrypt("manager"),
          invite_expiry: await encrypt(
            new Date(Date.now() - 1000).toISOString(),
          ),
          invite_wrapped_data_key: await wrapKeyWithToken(
            dataKey,
            "pw-set-code",
          ),
          password_hash: await encrypt("pbkdf2:1000:c2FsdA==:aGFzaA=="),
          username_hash: await encrypt("has-password"),
          username_index: await hmacHash("has-password"),
        }),
      );
      invalidateUsersCache();

      const pruned = await pruneExpiredInvites();
      expect(pruned).toBe(0);
      expect(await getUserByUsername("has-password")).not.toBeNull();
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
