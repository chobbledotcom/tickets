import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { generateRenewalToken } from "#shared/renewal-token.ts";

describe("generateRenewalToken", () => {
  test("returns a fresh token and its HMAC blind index", async () => {
    const first = await generateRenewalToken();
    const second = await generateRenewalToken();

    expect(first.token).not.toBe(second.token);
    expect(first.index).toBe(await hmacHash(first.token));
    expect(second.index).toBe(await hmacHash(second.token));
    // Tokens are long random strings, never empty.
    expect(first.token.length).toBeGreaterThanOrEqual(32);
  });
});
