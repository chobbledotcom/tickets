import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { apiKeyLimiter } from "#shared/db/api-key-attempts.ts";
import { loginLimiter } from "#shared/db/login-attempts.ts";
import { MAX_APIKEY_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("API-key attempt limiting", { db: true }, () => {
  test("locks an IP at the API-key attempt limit", async () => {
    for (let attempt = 1; attempt < MAX_APIKEY_ATTEMPTS; attempt++) {
      expect(await apiKeyLimiter.record("203.0.113.10")).toBe(false);
    }

    expect(await apiKeyLimiter.record("203.0.113.10")).toBe(true);
    expect(await apiKeyLimiter.isLimited("203.0.113.10")).toBe(true);
  });

  test("keeps API-key failures separate from login failures", async () => {
    for (let attempt = 0; attempt < MAX_APIKEY_ATTEMPTS; attempt++) {
      await apiKeyLimiter.record("198.51.100.7");
    }

    expect(await loginLimiter.isLimited("198.51.100.7")).toBe(false);
  });
});
