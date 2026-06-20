import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptWithKey } from "#shared/crypto/encryption.ts";
import {
  deriveKEKFromPassword,
  importPrivateKey,
  unwrapKey,
} from "#shared/crypto/keys.ts";
import { getAttendee } from "#shared/db/attendees.ts";
import { getDb, insert } from "#shared/db/client.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#shared/db/login-attempts.ts";
import { createSession, getSession } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#shared/db/users.ts";
import {
  bookAttendee,
  createTestListing,
  describeWithEnv,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describeWithEnv("db > auth", { db: true }, () => {
  describe("admin password", () => {
    test("verifyUserPassword returns hash for correct password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const result = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(result).toBeTruthy();
      expect(result).toContain("pbkdf2:");
    });

    test("verifyUserPassword returns null for wrong password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const result = await verifyUserPassword(user!, "wrong");
      expect(result).toBeNull();
    });

    test("updateUserPassword re-wraps DATA_KEY with new KEK", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const oldWrappedKey = user!.wrapped_data_key;

      const oldHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(oldHash).toBeTruthy();

      const success = await settings.updateUserPassword(user!.id, {
        newPassword: "newpassword456",
        oldKekVersion: user!.kek_version,
        oldPassword: TEST_ADMIN_PASSWORD,
        oldPasswordHash: oldHash!,
        oldWrappedDataKey: user!.wrapped_data_key!,
      });
      expect(success).toBe(true);

      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(updatedUser!.wrapped_data_key).not.toBe(oldWrappedKey);
      // Re-wrapped under the v2 (password-bound) scheme.
      expect(updatedUser!.kek_version).toBe(2);

      expect(
        await verifyUserPassword(updatedUser!, TEST_ADMIN_PASSWORD),
      ).toBeNull();

      expect(
        await verifyUserPassword(updatedUser!, "newpassword456"),
      ).toBeTruthy();
    });

    test("updateUserPassword fails with wrong old password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();

      const { settings: s } = await import("#shared/db/settings.ts");
      // v2 derives the unwrap KEK from the raw old password, so a wrong one can't
      // unwrap the DATA_KEY and the change is rejected.
      const success = await s.updateUserPassword(user!.id, {
        newPassword: "newpassword",
        oldKekVersion: user!.kek_version,
        oldPassword: "wrong-current-password",
        oldPasswordHash: "pbkdf2:bogus:hash",
        oldWrappedDataKey: user!.wrapped_data_key!,
      });
      expect(success).toBe(false);

      const unchanged = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(
        await verifyUserPassword(unchanged!, TEST_ADMIN_PASSWORD),
      ).toBeTruthy();
    });

    test("password change allows decryption of both old and new attendee records", async () => {
      const newPassword = "newpassword456";

      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Password Test Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      // Create an attendee BEFORE password change
      const beforeResult = await bookAttendee(listing, {
        email: "alice@example.com",
        name: "Alice Before",
        paymentId: "pi_before_change",
      });
      if (!beforeResult.success) throw new Error("Failed to create attendee");
      const attendeeBefore = beforeResult.attendees[0]!;

      // Change the password
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const oldHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(oldHash).toBeTruthy();

      const changeSuccess = await settings.updateUserPassword(user!.id, {
        newPassword,
        oldKekVersion: user!.kek_version,
        oldPassword: TEST_ADMIN_PASSWORD,
        oldPasswordHash: oldHash!,
        oldWrappedDataKey: user!.wrapped_data_key!,
      });
      expect(changeSuccess).toBe(true);

      // Create an attendee AFTER password change
      const afterResult = await bookAttendee(listing, {
        email: "bob@example.com",
        name: "Bob After",
        paymentId: "pi_after_change",
      });
      if (!afterResult.success) throw new Error("Failed to create attendee");
      const attendeeAfter = afterResult.attendees[0]!;

      // Get the private key using the NEW password
      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(updatedUser).not.toBeNull();
      const newPasswordHash = await verifyUserPassword(
        updatedUser!,
        newPassword,
      );
      expect(newPasswordHash).toBeTruthy();

      const kek = await deriveKEKFromPassword(newPassword, newPasswordHash!);
      const dataKey = await unwrapKey(updatedUser!.wrapped_data_key!, kek);

      const wrappedPrivateKey = settings.wrappedPrivateKey;
      expect(wrappedPrivateKey).toBeTruthy();

      const privateKeyJwk = await decryptWithKey(wrappedPrivateKey!, dataKey);
      const privateKey = await importPrivateKey(privateKeyJwk);

      // Decrypt the attendee created BEFORE password change
      const decryptedBefore = await getAttendee(attendeeBefore.id, privateKey);
      expect(decryptedBefore).not.toBeNull();
      expect(decryptedBefore?.name).toBe("Alice Before");
      expect(decryptedBefore?.email).toBe("alice@example.com");
      expect(decryptedBefore?.payment_id).toBe("pi_before_change");

      // Decrypt the attendee created AFTER password change
      const decryptedAfter = await getAttendee(attendeeAfter.id, privateKey);
      expect(decryptedAfter).not.toBeNull();
      expect(decryptedAfter?.name).toBe("Bob After");
      expect(decryptedAfter?.email).toBe("bob@example.com");
      expect(decryptedAfter?.payment_id).toBe("pi_after_change");
    });
  });

  describe("updateUserPassword invalidates sessions", () => {
    test("updates password and invalidates all sessions", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();

      await createSession("session1", "csrf1", Date.now() + 10000, null, 1);
      await createSession("session2", "csrf2", Date.now() + 10000, null, 1);

      const initialHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(initialHash).toBeTruthy();

      const success = await settings.updateUserPassword(user!.id, {
        newPassword: "new-password-123",
        oldKekVersion: user!.kek_version,
        oldPassword: TEST_ADMIN_PASSWORD,
        oldPasswordHash: initialHash!,
        oldWrappedDataKey: user!.wrapped_data_key!,
      });
      expect(success).toBe(true);

      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      const newValid = await verifyUserPassword(
        updatedUser!,
        "new-password-123",
      );
      expect(newValid).toBeTruthy();

      const oldValid = await verifyUserPassword(
        updatedUser!,
        TEST_ADMIN_PASSWORD,
      );
      expect(oldValid).toBeNull();

      const session1 = await getSession("session1");
      const session2 = await getSession("session2");
      expect(session1).toBeNull();
      expect(session2).toBeNull();
    });
  });

  describe("rate limiting", () => {
    test("isLoginRateLimited returns false for new IP", async () => {
      const limited = await isLoginRateLimited("192.168.1.1");
      expect(limited).toBe(false);
    });

    test("recordFailedLogin increments attempts", async () => {
      const locked1 = await recordFailedLogin("192.168.1.2");
      expect(locked1).toBe(false);

      const locked2 = await recordFailedLogin("192.168.1.2");
      expect(locked2).toBe(false);
    });

    test("recordFailedLogin locks after 5 attempts", async () => {
      for (let i = 0; i < 4; i++) {
        const locked = await recordFailedLogin("192.168.1.3");
        expect(locked).toBe(false);
      }

      const locked = await recordFailedLogin("192.168.1.3");
      expect(locked).toBe(true);
    });

    test("isLoginRateLimited returns true when locked", async () => {
      for (let i = 0; i < 5; i++) {
        await recordFailedLogin("192.168.1.4");
      }

      const limited = await isLoginRateLimited("192.168.1.4");
      expect(limited).toBe(true);
    });

    test("clearLoginAttempts clears attempts", async () => {
      await recordFailedLogin("192.168.1.5");
      await recordFailedLogin("192.168.1.5");

      await clearLoginAttempts("192.168.1.5");

      const limited = await isLoginRateLimited("192.168.1.5");
      expect(limited).toBe(false);
    });

    test("isLoginRateLimited clears expired lockout", async () => {
      await getDb().execute(
        insert("login_attempts", {
          attempts: 5,
          ip: "192.168.1.6",
          locked_until: Date.now() - 1000,
        }),
      );

      const limited = await isLoginRateLimited("192.168.1.6");
      expect(limited).toBe(false);
    });

    test("isLoginRateLimited returns false for attempts below max without lockout", async () => {
      await getDb().execute(
        insert("login_attempts", {
          attempts: 3,
          ip: "192.168.1.7",
          locked_until: null,
        }),
      );

      const limited = await isLoginRateLimited("192.168.1.7");
      expect(limited).toBe(false);
    });

    test("isLoginRateLimited resets expired lockout and returns false", async () => {
      const ip = "192.168.99.1";

      for (let i = 0; i < 5; i++) {
        await recordFailedLogin(ip);
      }
      expect(await isLoginRateLimited(ip)).toBe(true);

      // Simulate expired lockout
      await getDb().execute({
        args: [Date.now() - 1000],
        sql: `UPDATE login_attempts
              SET locked_until = ?
              WHERE locked_until IS NOT NULL`,
      });

      const limited = await isLoginRateLimited(ip);
      expect(limited).toBe(false);

      const locked = await recordFailedLogin(ip);
      expect(locked).toBe(false);
    });
  });
});
