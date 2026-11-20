import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptWithKey } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { importPrivateKey } from "#crypto/hybrid.ts";
import { deriveKEKFromPassword, unwrapKey } from "#crypto/keys.ts";
import type { KeyEncrypted, PasswordHash } from "#crypto/sealed.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { getDb } from "#db/client.ts";
import { clearLoginAttempts, loginLimiter } from "#db/login-attempts.ts";
import { tables } from "#db/select/tables.ts";
import { getSession } from "#db/sessions.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { getUserByUsername, verifyUserPassword } from "#db/users.ts";
import { insertInto } from "#db/write.ts";
import { MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  assertAdminPasswordRejects,
  assertAdminPasswordVerifies,
} from "#test-utils/db-helpers/misc.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { createLiveSessions } from "#test-utils/live-sessions.ts";
import type { User } from "#types";

describeWithEnv("db > auth", { db: true }, () => {
  /** Change the admin password the way the settings screen does: verify the
   *  stored hash of the old password, hand it to `updateUserPassword`, and
   *  assert the change took. Both rows come back so a caller can compare the
   *  re-wrapped DATA_KEY or derive the new KEK. */
  const changeAdminPassword = async (
    newPassword: string,
  ): Promise<{ after: User; before: User }> => {
    const before = await getUserByUsername(TEST_ADMIN_USERNAME);
    expect(before).not.toBeNull();
    const oldHash = await verifyUserPassword(before!, TEST_ADMIN_PASSWORD);
    expect(oldHash).toMatch(/^pbkdf2:/);

    const changed = await settings.updateUserPassword(before!.id, {
      newPassword,
      oldKekVersion: before!.kekVersion,
      oldPassword: TEST_ADMIN_PASSWORD,
      oldPasswordHash: oldHash!,
      oldWrappedDataKey: before!.wrappedDataKey!,
    });
    expect(changed).toBe(true);

    const after = await getUserByUsername(TEST_ADMIN_USERNAME);
    expect(after).not.toBeNull();
    return { after: after!, before: before! };
  };

  /** Record the configured maximum of attempts for `ip`, as a client that
   *  keeps typing the wrong password would, and report whether the limiter
   *  now holds it out. */
  const lockOut = async (ip: string): Promise<boolean> => {
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
      await loginLimiter.record(ip);
    }
    return loginLimiter.isLimited(ip);
  };

  describe("admin password", () => {
    test("verifyUserPassword returns hash for correct password", () =>
      assertAdminPasswordVerifies());

    test("verifyUserPassword returns null for wrong password", () =>
      assertAdminPasswordRejects());

    test("updateUserPassword re-wraps DATA_KEY with new KEK", async () => {
      const { after, before } = await changeAdminPassword("newpassword456");

      expect(after.wrappedDataKey).not.toBe(before.wrappedDataKey);
      // Re-wrapped under the v2 (password-bound) scheme.
      expect(after.kekVersion).toBe(2);

      expect(await verifyUserPassword(after, TEST_ADMIN_PASSWORD)).toBeNull();

      expect(await verifyUserPassword(after, "newpassword456")).toMatch(
        /^pbkdf2:/,
      );
    });

    test("updateUserPassword fails with wrong old password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();

      const { settings: s } = await import("#db/settings.ts");
      // v2 derives the unwrap KEK from the raw old password, so a wrong one can't
      // unwrap the DATA_KEY and the change is rejected.
      const success = await s.updateUserPassword(user!.id, {
        newPassword: "newpassword",
        oldKekVersion: user!.kekVersion,
        oldPassword: "wrong-current-password",
        // Hand-crafted bogus stored hash — test fixture cast.
        oldPasswordHash: "pbkdf2:bogus:hash" as PasswordHash,
        oldWrappedDataKey: user!.wrappedDataKey!,
      });
      expect(success).toBe(false);

      const unchanged = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(await verifyUserPassword(unchanged!, TEST_ADMIN_PASSWORD)).toMatch(
        /^pbkdf2:/,
      );
    });

    test("password change allows decryption of both old and new attendee records", async () => {
      const newPassword = "newpassword456";

      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Password Test Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      // Create an attendee BEFORE password change
      const attendeeBefore = bookedAttendee(
        await bookAttendee(listing, {
          email: "alice@example.com",
          name: "Alice Before",
          paymentId: "pi_before_change",
        }),
      );

      // Change the password
      const { after: updatedUser } = await changeAdminPassword(newPassword);

      // Create an attendee AFTER password change
      const attendeeAfter = bookedAttendee(
        await bookAttendee(listing, {
          email: "bob@example.com",
          name: "Bob After",
          paymentId: "pi_after_change",
        }),
      );

      // Get the private key using the NEW password
      const newPasswordHash = await verifyUserPassword(
        updatedUser,
        newPassword,
      );
      expect(newPasswordHash).toMatch(/^pbkdf2:/);

      const kek = await deriveKEKFromPassword(newPassword, newPasswordHash!);
      const dataKey = await unwrapKey(updatedUser.wrappedDataKey!, kek);

      const wrappedPrivateKey = settings.wrappedPrivateKey;
      expect(wrappedPrivateKey).not.toBe("");

      // Asserted non-empty above, so the "" branch of the union is excluded.
      const privateKeyJwk = await decryptWithKey(
        wrappedPrivateKey as KeyEncrypted,
        dataKey,
      );
      const privateKey = await importPrivateKey(privateKeyJwk);

      // The attendee booked BEFORE the change and the one booked AFTER it both
      // decrypt under the re-wrapped key.
      for (const expected of [
        {
          attendee: attendeeBefore,
          email: "alice@example.com",
          name: "Alice Before",
          paymentId: "pi_before_change",
        },
        {
          attendee: attendeeAfter,
          email: "bob@example.com",
          name: "Bob After",
          paymentId: "pi_after_change",
        },
      ]) {
        const decrypted = await getAttendeeOrNull(
          expected.attendee.id,
          privateKey,
        );
        expect(decrypted).not.toBeNull();
        expect(decrypted?.name).toBe(expected.name);
        expect(decrypted?.email).toBe(expected.email);
        expect(decrypted?.payment_id).toBe(expected.paymentId);
      }
    });
  });

  describe("updateUserPassword invalidates sessions", () => {
    test("updates password and invalidates all sessions", async () => {
      await createLiveSessions(["session1", "session2"]);

      const { after: updatedUser } =
        await changeAdminPassword("new-password-123");

      expect(await verifyUserPassword(updatedUser, "new-password-123")).toMatch(
        /^pbkdf2:/,
      );

      expect(
        await verifyUserPassword(updatedUser, TEST_ADMIN_PASSWORD),
      ).toBeNull();

      const session1 = await getSession("session1");
      const session2 = await getSession("session2");
      expect(session1).toBeNull();
      expect(session2).toBeNull();
    });
  });

  describe("rate limiting", () => {
    test("login limiter returns false for new IP", async () => {
      const limited = await loginLimiter.isLimited("192.168.1.1");
      expect(limited).toBe(false);
    });

    test("login limiter records attempts", async () => {
      const locked1 = await loginLimiter.record("192.168.1.2");
      expect(locked1).toBe(false);

      const locked2 = await loginLimiter.record("192.168.1.2");
      expect(locked2).toBe(false);
    });

    test("stores login attempts under the unprefixed IP hash", async () => {
      const ip = "192.168.1.8";
      await loginLimiter.record(ip);

      const row = await getDb().execute(
        sql`SELECT attempts FROM login_attempts WHERE ip = ${await hmacHash(ip)}`,
      );
      expect(row.rows).toEqual([{ attempts: 1 }]);
    });

    test("login limiter locks at the configured attempt limit", async () => {
      for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i++) {
        const locked = await loginLimiter.record("192.168.1.3");
        expect(locked).toBe(false);
      }

      const locked = await loginLimiter.record("192.168.1.3");
      expect(locked).toBe(true);
    });

    test("login limiter returns true when locked", async () => {
      expect(await lockOut("192.168.1.4")).toBe(true);
    });

    test("clearLoginAttempts clears attempts", async () => {
      const ip = "192.168.1.5";
      expect(await lockOut(ip)).toBe(true);

      await clearLoginAttempts(ip);

      expect(await loginLimiter.isLimited(ip)).toBe(false);
    });

    test("login limiter clears expired lockout", async () => {
      const ip = "192.168.1.6";
      const ipHash = await hmacHash(ip);
      await getDb().execute(
        insertInto(tables.login_attempts, {
          attempts: MAX_LOGIN_ATTEMPTS,
          ip: ipHash,
          lockedUntil: Date.now() - 1000,
        }),
      );

      expect(await loginLimiter.isLimited(ip)).toBe(false);
      const row = await getDb().execute(
        sql`SELECT attempts FROM login_attempts WHERE ip = ${ipHash}`,
      );
      expect(row.rows).toEqual([]);
    });

    test("login limiter returns false for attempts below max without lockout", async () => {
      const ip = "192.168.1.7";
      await getDb().execute(
        insertInto(tables.login_attempts, {
          attempts: MAX_LOGIN_ATTEMPTS - 1,
          ip: await hmacHash(ip),
          lockedUntil: null,
        }),
      );

      expect(await loginLimiter.isLimited(ip)).toBe(false);
      expect(await loginLimiter.record(ip)).toBe(true);
    });

    test("login limiter resets expired lockout and returns false", async () => {
      const ip = "192.168.99.1";

      expect(await lockOut(ip)).toBe(true);

      // Simulate expired lockout
      await getDb().execute(sql`UPDATE login_attempts
              SET locked_until = ${Date.now() - 1000}
              WHERE locked_until IS NOT NULL`);

      const limited = await loginLimiter.isLimited(ip);
      expect(limited).toBe(false);

      const locked = await loginLimiter.record(ip);
      expect(locked).toBe(false);
    });
  });
});
