import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { queryOne } from "#db/client.ts";
import {
  clearLoginAttempts,
  loginLimiter,
  makeIpRateLimiter,
} from "#db/login-attempts.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("login attempt limiting", { db: true }, () => {
  test("locks at the configured threshold until the exact deadline", async () => {
    using time = new FakeTime(1_800_000_000_000);
    const limiter = makeIpRateLimiter("test:", 2, 1000);

    expect(await limiter.record("203.0.113.10")).toBe(false);
    expect(await limiter.record("203.0.113.10")).toBe(true);
    expect(
      await queryOne<{ attempts: number; locked_until: number }>(
        "SELECT attempts, locked_until FROM login_attempts",
      ),
    ).toEqual({ attempts: 2, locked_until: 1_800_000_001_000 });
    expect(await limiter.isLimited("203.0.113.10")).toBe(true);

    await time.tickAsync(1000);
    expect(await limiter.isLimited("203.0.113.10")).toBe(false);
  });

  test("concurrent attempts each count and lock at the threshold", async () => {
    const limiter = makeIpRateLimiter("race:", 5, 1000);
    const ip = "203.0.113.20";

    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.record(ip)),
    );

    // Every attempt lands as its own increment; exactly one of them was the
    // locking fifth. A read-then-write recorder loses concurrent increments
    // (all five read zero attempts) and never locks.
    expect(results.filter((locked) => locked)).toHaveLength(1);
    expect(
      await queryOne<{ attempts: number }>(
        "SELECT attempts FROM login_attempts",
      ),
    ).toEqual({ attempts: 5 });
    expect(await limiter.isLimited(ip)).toBe(true);
  });

  test("stamps last_attempt so stale counters can be pruned", async () => {
    using time = new FakeTime(1_800_000_000_000);
    const limiter = makeIpRateLimiter("stamp:", 5, 1000);
    const ip = "203.0.113.21";

    await limiter.record(ip);
    time.tick(60_000);
    await limiter.record(ip);

    expect(
      await queryOne<{ last_attempt: number }>(
        "SELECT last_attempt FROM login_attempts",
      ),
    ).toEqual({ last_attempt: 1_800_000_060_000 });
  });

  test("clears failed attempts after a successful login", async () => {
    const ip = "203.0.113.11";
    await loginLimiter.record(ip);
    expect(
      await queryOne("SELECT ip FROM login_attempts WHERE attempts = 1"),
    ).not.toBeNull();

    await clearLoginAttempts(ip);

    expect(await queryOne("SELECT ip FROM login_attempts")).toBeNull();
  });
});
