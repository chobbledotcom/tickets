import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { queryOne } from "#shared/db/client.ts";
import {
  clearLoginAttempts,
  loginLimiter,
  makeIpRateLimiter,
} from "#shared/db/login-attempts.ts";
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
