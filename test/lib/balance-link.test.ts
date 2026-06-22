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

  // Build a correctly-signed "bal1." token wrapping an arbitrary payload, so a
  // test can exercise the shape validation with a signature that already passes.
  const signRawPayload = async (payload: unknown): Promise<string> => {
    const { buildSignedToken, encodeTokenPayload } = await import(
      "#shared/crypto/signed-token.ts"
    );
    const encoded = encodeTokenPayload(payload);
    return buildSignedToken("bal1.", encoded, `balance:${encoded}`);
  };

  test("a balance link is valid for 90 days", () => {
    // Pins the link lifetime to 90 days, expressed in seconds (90 × 86,400).
    // Lengthening or shortening the window is a behaviour change to catch here.
    expect(BALANCE_LINK_MAX_AGE_S).toBe(7_776_000);
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
    const token = await signRawPayload({ not: "a balance" });
    expect(await verifyBalanceToken(token)).toBeNull();
  });

  test("rejects a correctly-signed token whose attendee id is not a number", async () => {
    // Signature and expiry are valid (a plausible near-future second), but `a`
    // is a string. The id field must be validated independently of the expiry,
    // and reach this check before the expiry/skew bounds can rescue it.
    const validExpiry = Math.floor(Date.now() / 1000) + 1000;
    const token = await signRawPayload({ a: "42", e: validExpiry });
    expect(await verifyBalanceToken(token)).toBeNull();
  });

  test("rejects a correctly-signed token whose expiry is not a number", async () => {
    // Signature is valid and `a` is a number, but `e` is a string. The expiry
    // field must be validated independently of the id field.
    const token = await signRawPayload({ a: 42, e: "soon" });
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
