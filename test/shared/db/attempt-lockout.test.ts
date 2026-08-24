import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { hmacHash } from "#crypto/hashing.ts";
import { clearAttemptsFor, lockoutActive } from "#db/attempt-lockout.ts";
import { execute, queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const insertLockout = async (
  hashedIp: string,
  lockedUntil: number,
): Promise<void> => {
  await execute(
    "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, 5, ?)",
    [hashedIp, lockedUntil],
  );
};

const storedLockedUntil = async (
  hashedIp: string,
): Promise<number | null | undefined> => {
  const row = await queryOne<{ locked_until: number | null }>(
    "SELECT loginAttempt.locked_until FROM login_attempts AS loginAttempt WHERE loginAttempt.ip = ?",
    [hashedIp],
  );
  return row?.locked_until;
};

describeWithEnv("attempt lockout", { db: true }, () => {
  test("no stored lockout reads as not limited", async () => {
    const hashedIp = await hmacHash("198.51.100.1");
    expect(await lockoutActive("login_attempts", hashedIp, null)).toBe(false);
    expect(await lockoutActive("login_attempts", hashedIp, undefined)).toBe(
      false,
    );
  });

  test("a future lockout is active and the row is kept", async () => {
    using time = new FakeTime(1_800_000_000_000);
    const hashedIp = await hmacHash("198.51.100.2");
    const lockedUntil = time.now + 60_000;
    await insertLockout(hashedIp, lockedUntil);

    expect(await lockoutActive("login_attempts", hashedIp, lockedUntil)).toBe(
      true,
    );
    expect(await storedLockedUntil(hashedIp)).toBe(lockedUntil);
  });

  test("an expired lockout is removed so the next attempt starts fresh", async () => {
    using time = new FakeTime(1_800_000_000_000);
    const hashedIp = await hmacHash("198.51.100.3");
    const expired = time.now - 1;
    await insertLockout(hashedIp, expired);

    expect(await lockoutActive("login_attempts", hashedIp, expired)).toBe(
      false,
    );
    expect(await storedLockedUntil(hashedIp)).toBeUndefined();
  });

  test("cleanup of an expired lockout keeps a fresh lockout another request wrote", async () => {
    using time = new FakeTime(1_800_000_000_000);
    const hashedIp = await hmacHash("198.51.100.4");
    const expired = time.now - 1;
    const fresh = time.now + 60_000;
    // Another request re-locked this IP between our read and our cleanup.
    await insertLockout(hashedIp, fresh);

    expect(await lockoutActive("login_attempts", hashedIp, expired)).toBe(
      false,
    );
    expect(await storedLockedUntil(hashedIp)).toBe(fresh);
    expect(await lockoutActive("login_attempts", hashedIp, fresh)).toBe(true);
  });

  test("clearing one IP removes only that IP's row", async () => {
    const cleared = "198.51.100.5";
    const kept = "198.51.100.6";
    const keptHash = await hmacHash(kept);
    await insertLockout(await hmacHash(cleared), 1);
    await insertLockout(keptHash, 2);

    await clearAttemptsFor("login_attempts")(cleared);

    expect(await storedLockedUntil(await hmacHash(cleared))).toBeUndefined();
    expect(await storedLockedUntil(keptHash)).toBe(2);
  });
});
