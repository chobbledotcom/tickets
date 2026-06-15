import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  BALANCE_LINK_MAX_AGE_S,
  signBalanceToken,
  verifyBalanceToken,
} from "#shared/balance-link.ts";
import { setupTestEncryptionKey } from "#test-utils";

describe("balance-link", () => {
  beforeAll(() => {
    setupTestEncryptionKey();
  });

  test("signs and verifies a token for an attendee", async () => {
    const token = await signBalanceToken(42);
    expect(token.startsWith("bal1.")).toBe(true);
    const payload = await verifyBalanceToken(token);
    expect(payload?.a).toBe(42);
    expect(payload?.e).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("rejects a token without the expected prefix", async () => {
    expect(await verifyBalanceToken("nope.abc.def")).toBeNull();
  });

  test("rejects a malformed token", async () => {
    expect(await verifyBalanceToken("bal1.onlyonepart")).toBeNull();
    expect(await verifyBalanceToken("bal1.")).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await signBalanceToken(42);
    const [, , hmac] = token.split(".");
    // Swap in a payload for a different attendee while keeping the signature.
    const forgedPayload = btoa(JSON.stringify({ a: 999, e: 9999999999 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyBalanceToken(`bal1.${forgedPayload}.${hmac}`),
    ).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const token = await signBalanceToken(42);
    const [, payload] = token.split(".");
    expect(await verifyBalanceToken(`bal1.${payload}.deadbeef`)).toBeNull();
  });

  test("rejects a correctly-signed token whose payload is the wrong shape", async () => {
    // Sign a non-conforming payload with a valid HMAC, so the signature passes
    // but the field validation rejects it.
    const { buildSignedToken, encodeTokenPayload } = await import(
      "#shared/crypto/signed-token.ts"
    );
    const encoded = encodeTokenPayload({ not: "a balance" });
    const token = await buildSignedToken(
      "bal1.",
      encoded,
      `balance:${encoded}`,
    );
    expect(await verifyBalanceToken(token)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const token = await signBalanceToken(42, -10);
    expect(await verifyBalanceToken(token)).toBeNull();
  });

  test("rejects a token dated implausibly far in the future", async () => {
    const token = await signBalanceToken(42, BALANCE_LINK_MAX_AGE_S + 1000);
    expect(await verifyBalanceToken(token)).toBeNull();
  });
});
