import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  isSignedCsrfToken,
  signCsrfToken,
  verifySignedCsrfToken,
} from "#shared/csrf.ts";
import { setupTestEncryptionKey } from "#test-utils";

describe("signCsrfToken", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  test("produces a token with s1. prefix", async () => {
    const token = await signCsrfToken();
    expect(token.startsWith("s1.")).toBe(true);
  });

  test("produces a token with four dot-separated parts", async () => {
    const token = await signCsrfToken();
    const parts = token.split(".");
    expect(parts.length).toBe(4);
  });

  test("includes a numeric timestamp", async () => {
    const token = await signCsrfToken();
    const parts = token.split(".");
    const timestamp = Number.parseInt(parts[1]!, 10);
    expect(Number.isNaN(timestamp)).toBe(false);
    const nowS = Math.floor(Date.now() / 1000);
    expect(Math.abs(timestamp - nowS)).toBeLessThan(5);
  });

  test("generates unique tokens on each call", async () => {
    const a = await signCsrfToken();
    const b = await signCsrfToken();
    expect(a).not.toBe(b);
  });
});

describe("isSignedCsrfToken", () => {
  test("returns true for signed tokens", async () => {
    setupTestEncryptionKey();
    const token = await signCsrfToken();
    expect(isSignedCsrfToken(token)).toBe(true);
  });

  test("returns false for plain tokens", () => {
    expect(isSignedCsrfToken("abcdef123456")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isSignedCsrfToken("")).toBe(false);
  });
});

describe("verifySignedCsrfToken", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  test("accepts a freshly signed token", async () => {
    const token = await signCsrfToken();
    expect(await verifySignedCsrfToken(token)).toBe(true);
  });

  test("rejects a token with tampered HMAC", async () => {
    const token = await signCsrfToken();
    const tampered = `${token.slice(0, -4)}XXXX`;
    expect(await verifySignedCsrfToken(tampered)).toBe(false);
  });

  test("rejects a token with tampered nonce", async () => {
    const token = await signCsrfToken();
    const parts = token.split(".");
    parts[2] = "tampered-nonce-value";
    expect(await verifySignedCsrfToken(parts.join("."))).toBe(false);
  });

  test("rejects a token with tampered timestamp", async () => {
    const token = await signCsrfToken();
    const parts = token.split(".");
    parts[1] = "9999999999";
    expect(await verifySignedCsrfToken(parts.join("."))).toBe(false);
  });

  test("rejects an expired token", async () => {
    const token = await signCsrfToken();
    // Verify with maxAge=-1 so the token is already expired
    expect(await verifySignedCsrfToken(token, -1)).toBe(false);
  });

  test("rejects a token once real elapsed time exceeds maxAge", async () => {
    using time = new FakeTime(1_000_000_000_000);
    const token = await signCsrfToken();
    // Accepted while still inside the window...
    expect(await verifySignedCsrfToken(token, 60)).toBe(true);
    // ...then advance real time past maxAge so age (120s) > maxAge (60s).
    time.tick(120_000);
    expect(await verifySignedCsrfToken(token, 60)).toBe(false);
  });

  test("rejects a token dated more than 60s in the future", async () => {
    // Sign under a far-future clock so the token's timestamp is well ahead
    // of "now"; FakeTime cannot move backwards, so verify under a separate
    // present-time clock. The gap (decades) far exceeds the 60s skew window.
    const signedInFuture = await (async () => {
      const future = new FakeTime(4_000_000_000_000);
      try {
        return await signCsrfToken();
      } finally {
        future.restore();
      }
    })();

    const present = new FakeTime(1_700_000_000_000);
    try {
      expect(await verifySignedCsrfToken(signedInFuture)).toBe(false);
    } finally {
      present.restore();
    }
  });

  test("rejects a plain (unsigned) token", async () => {
    expect(await verifySignedCsrfToken("plain-random-token")).toBe(false);
  });

  test("rejects an empty string", async () => {
    expect(await verifySignedCsrfToken("")).toBe(false);
  });

  test("rejects a token with wrong number of parts", async () => {
    expect(await verifySignedCsrfToken("s1.only-two-parts")).toBe(false);
    expect(await verifySignedCsrfToken("s1.a.b.c.d.extra")).toBe(false);
  });

  test("rejects a token with empty parts", async () => {
    expect(await verifySignedCsrfToken("s1..nonce.hmac")).toBe(false);
  });

  test("rejects a token with non-numeric timestamp", async () => {
    expect(await verifySignedCsrfToken("s1.notanumber.nonce.hmac")).toBe(false);
  });
});
