import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bearerAuthorization, bearerTokenOrNull } from "#shared/bearer.ts";

describe("bearer authorization", () => {
  test("builds a bearer authorization value", () => {
    expect(bearerAuthorization("site-key")).toBe("Bearer site-key");
  });

  for (const authorization of ["Bearer site-key", "bearer site-key"]) {
    test(`reads ${authorization}`, () => {
      expect(bearerTokenOrNull(authorization)).toBe("site-key");
    });
  }

  for (const authorization of [null, "", "Basic site-key", "Bearer two keys"]) {
    test(`rejects ${String(authorization)}`, () => {
      expect(bearerTokenOrNull(authorization)).toBeNull();
    });
  }
});
