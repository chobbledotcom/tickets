import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  SQUARE_ACCESS_TOKEN_PREFIX,
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

describe("validateSquareAccessToken", () => {
  test("accepts a token with the EAAA prefix", () => {
    expect(
      validateSquareAccessToken(`${SQUARE_ACCESS_TOKEN_PREFIX}l_real_token`),
    ).toBeNull();
  });

  test("rejects a production application ID/secret", () => {
    const error = validateSquareAccessToken("sq0idp-EXAMPLE");
    expect(error).toContain("application ID or secret");
  });

  test("rejects a sandbox application credential", () => {
    const error = validateSquareAccessToken("sandbox-sq0idb-EXAMPLE");
    expect(error).toContain("application ID or secret");
  });

  test("rejects a value missing the access token prefix", () => {
    const error = validateSquareAccessToken("not-a-real-token");
    expect(error).toContain(SQUARE_ACCESS_TOKEN_PREFIX);
  });
});

describe("validateSquareLocationId", () => {
  test("accepts a normal location ID", () => {
    expect(validateSquareLocationId("LH182V1KBR6V2")).toBeNull();
  });

  test("rejects an access token pasted into the location field", () => {
    const error = validateSquareLocationId(
      `${SQUARE_ACCESS_TOKEN_PREFIX}l_token`,
    );
    expect(error).toContain("access token");
  });

  test("rejects an application ID pasted into the location field", () => {
    const error = validateSquareLocationId("sq0idp-EXAMPLE");
    expect(error).toContain("application ID");
  });
});

describe("validateSquareWebhookSignatureKey", () => {
  test("accepts a plausible signature key", () => {
    expect(validateSquareWebhookSignatureKey("aZ9_-realLookingKey")).toBeNull();
  });

  test("rejects an access token pasted into the signature key field", () => {
    const error = validateSquareWebhookSignatureKey(
      `${SQUARE_ACCESS_TOKEN_PREFIX}l_token`,
    );
    expect(error).toContain("access token");
  });

  test("rejects an application ID pasted into the signature key field", () => {
    const error = validateSquareWebhookSignatureKey("sq0idp-EXAMPLE");
    expect(error).toContain("application ID");
  });
});
