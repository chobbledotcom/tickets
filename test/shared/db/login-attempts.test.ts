import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import { clearLoginAttempts, loginLimiter } from "#shared/db/login-attempts.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("login attempt limiting", { db: true }, () => {
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
