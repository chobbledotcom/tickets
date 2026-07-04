import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  defineSignedToken,
  type ExpiringPayload,
} from "#shared/crypto/define-signed-token.ts";
import {
  buildSignedToken,
  encodeTokenPayload,
} from "#shared/crypto/signed-token.ts";
import { setupTestEncryptionKey } from "#test-utils";

// A minimal scheme exercising the factory directly: the payload has one extra
// field beyond the expiry, and the HMAC message is keyed by a string context so
// the context-binding branch is covered independently of the real token types.
type ToyPayload = ExpiringPayload & { x: number };

const MAX_AGE_S = 100;

const toy = defineSignedToken<ToyPayload, string>({
  maxAgeS: MAX_AGE_S,
  message: (context, encoded) => `toy:${context}:${encoded}`,
  parse: (parsed) =>
    typeof parsed.x === "number" && typeof parsed.e === "number"
      ? (parsed as unknown as ToyPayload)
      : null,
  prefix: "toy1.",
});

const nowS = (): number => Math.floor(Date.now() / 1000);

// Forge a correctly-signed token wrapping an arbitrary payload for the toy
// scheme's context, so shape/expiry checks run with a passing signature.
const forge = (context: string, payload: unknown): Promise<string> => {
  const encoded = encodeTokenPayload(payload);
  return buildSignedToken("toy1.", encoded, `toy:${context}:${encoded}`);
};

describe("defineSignedToken", () => {
  beforeAll(() => {
    setupTestEncryptionKey();
  });

  test("signs a token with the scheme prefix", async () => {
    const token = await toy.sign("ctx", { e: nowS() + 50, x: 7 });
    expect(token.startsWith("toy1.")).toBe(true);
  });

  test("verifies a token it signed, returning the typed payload", async () => {
    const token = await toy.sign("ctx", { e: nowS() + 50, x: 7 });
    const payload = await toy.verify("ctx", token);
    expect(payload).toEqual({ e: expect.any(Number), x: 7 });
  });

  test("rejects a token verified under a different context", async () => {
    // The context is bound into the HMAC message, so a token minted for one
    // context must not verify for another even with an untouched signature.
    const token = await toy.sign("ctx-a", { e: nowS() + 50, x: 7 });
    expect(await toy.verify("ctx-b", token)).toBeNull();
  });

  test("rejects a token without the scheme prefix", async () => {
    expect(await toy.verify("ctx", "other1.abc.def")).toBeNull();
  });

  test("rejects a token with a tampered signature", async () => {
    const token = await toy.sign("ctx", { e: nowS() + 50, x: 7 });
    const [, encoded] = token.split(".");
    expect(await toy.verify("ctx", `toy1.${encoded}.deadbeef`)).toBeNull();
  });

  test("rejects a correctly-signed payload that is not an object", async () => {
    const token = await forge("ctx", 42);
    expect(await toy.verify("ctx", token)).toBeNull();
  });

  test("rejects a correctly-signed payload of the wrong shape", async () => {
    // Valid HMAC and a valid expiry, but the required `x` field is missing, so
    // the scheme's structural guard must reject before the expiry check.
    const token = await forge("ctx", { e: nowS() + 50 });
    expect(await toy.verify("ctx", token)).toBeNull();
  });

  test("rejects an expired token", async () => {
    // Signature and shape are valid; only the expiry is in the past.
    const token = await toy.sign("ctx", { e: nowS() - 10, x: 7 });
    expect(await toy.verify("ctx", token)).toBeNull();
  });

  test("rejects a token dated implausibly far in the future", async () => {
    const token = await toy.sign("ctx", { e: nowS() + MAX_AGE_S + 1000, x: 7 });
    expect(await toy.verify("ctx", token)).toBeNull();
  });
});
