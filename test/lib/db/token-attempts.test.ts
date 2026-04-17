/**
 * Tests for token_attempts rate limiting.
 *
 * Rule: 5 different invalid token hashes within TOKEN_WINDOW_MS trigger a
 * TOKEN_LOCKOUT_MS lockout. Re-trying the same invalid token doesn't count.
 * Successful lookups never invoke recordTokenFailure.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  clearTokenAttempts,
  isTokenRateLimited,
  recordTokenFailure,
} from "#lib/db/token-attempts.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#lib/limits.ts";
import { describeWithEnv } from "#test-utils";

const makeTokens = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

describeWithEnv("db > token-attempts", { db: true }, () => {
  describe("isTokenRateLimited", () => {
    test("returns false for new IP", async () => {
      const limited = await isTokenRateLimited("10.0.0.1");
      expect(limited).toBe(false);
    });

    test("returns true after MAX_TOKEN_404S distinct failures", async () => {
      const ip = "10.0.0.2";
      const locked = await recordTokenFailure(
        ip,
        makeTokens("tok-a", MAX_TOKEN_404S),
      );
      expect(locked).toBe(true);
      expect(await isTokenRateLimited(ip)).toBe(true);
    });

    test("resets expired lockout and returns false", async () => {
      const ip = "10.0.0.3";
      const time = new FakeTime(1_800_000_000_000);
      try {
        await recordTokenFailure(ip, makeTokens("tok-b", MAX_TOKEN_404S));
        expect(await isTokenRateLimited(ip)).toBe(true);

        time.tick(TOKEN_LOCKOUT_MS + 1);
        expect(await isTokenRateLimited(ip)).toBe(false);
      } finally {
        time.restore();
      }
    });
  });

  describe("recordTokenFailure", () => {
    test("does not lock below threshold", async () => {
      const ip = "10.0.0.4";
      const locked = await recordTokenFailure(
        ip,
        makeTokens("tok-c", MAX_TOKEN_404S - 1),
      );
      expect(locked).toBe(false);
      expect(await isTokenRateLimited(ip)).toBe(false);
    });

    test("repeat failures on the same token do not count toward the limit", async () => {
      const ip = "10.0.0.5";
      for (let i = 0; i < MAX_TOKEN_404S + 3; i++) {
        const locked = await recordTokenFailure(ip, ["same-token"]);
        expect(locked).toBe(false);
      }
      expect(await isTokenRateLimited(ip)).toBe(false);
    });

    test("locks on the Nth distinct token across multiple calls", async () => {
      const ip = "10.0.0.6";
      for (let i = 0; i < MAX_TOKEN_404S - 1; i++) {
        const locked = await recordTokenFailure(ip, [`d-${i}`]);
        expect(locked).toBe(false);
      }
      const finalLocked = await recordTokenFailure(ip, ["d-final"]);
      expect(finalLocked).toBe(true);
    });

    test("ignores attempts older than TOKEN_WINDOW_MS", async () => {
      const ip = "10.0.0.7";
      const time = new FakeTime(1_800_000_000_000);
      try {
        for (let i = 0; i < MAX_TOKEN_404S - 1; i++) {
          await recordTokenFailure(ip, [`old-${i}`]);
        }

        time.tick(TOKEN_WINDOW_MS + 1);

        const locked = await recordTokenFailure(ip, ["fresh"]);
        expect(locked).toBe(false);
        expect(await isTokenRateLimited(ip)).toBe(false);
      } finally {
        time.restore();
      }
    });

    test("empty token list is a no-op", async () => {
      const ip = "10.0.0.8";
      const locked = await recordTokenFailure(ip, []);
      expect(locked).toBe(false);
      expect(await isTokenRateLimited(ip)).toBe(false);
    });

    test("locks when a single request supplies MAX_TOKEN_404S distinct tokens", async () => {
      const ip = "10.0.0.9";
      const locked = await recordTokenFailure(
        ip,
        makeTokens("burst", MAX_TOKEN_404S),
      );
      expect(locked).toBe(true);
    });
  });

  describe("clearTokenAttempts", () => {
    test("removes tracked attempts for an IP", async () => {
      const ip = "10.0.0.10";
      await recordTokenFailure(ip, makeTokens("clr", MAX_TOKEN_404S));
      expect(await isTokenRateLimited(ip)).toBe(true);

      await clearTokenAttempts(ip);
      expect(await isTokenRateLimited(ip)).toBe(false);
    });
  });
});
