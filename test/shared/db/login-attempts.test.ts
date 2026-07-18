import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { clearLoginAttempts, loginLimiter } from "#shared/db/login-attempts.ts";
import { MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("login attempt limiting", { db: true }, () => {
  test("clears the lock after a successful login", async () => {
    const ip = "203.0.113.11";
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
      await loginLimiter.record(ip);
    }
    expect(await loginLimiter.isLimited(ip)).toBe(true);

    await clearLoginAttempts(ip);

    expect(await loginLimiter.isLimited(ip)).toBe(false);
  });
});
