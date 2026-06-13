import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  SQUARE_ACCESS_TOKEN_PREFIX,
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

describe("validateSquareAccessToken", () => {
  test("accepts a current-style token with the EAAA prefix", () => {
    expect(
      validateSquareAccessToken(`${SQUARE_ACCESS_TOKEN_PREFIX}l_real_token`),
    ).toBeNull();
  });

  test("accepts a JWT (eyJ) access token", () => {
    expect(
      validateSquareAccessToken("eyJhbGciOiJ.eyJzdWIiOiJ.signature_part-_"),
    ).toBeNull();
  });

  test("accepts a legacy personal access token (sq0atp-)", () => {
    expect(validateSquareAccessToken("sq0atp-legacy_token_value")).toBeNull();
  });

  test("accepts a legacy sandbox personal access token", () => {
    expect(
      validateSquareAccessToken("sandbox-sq0atp-legacy_token_value"),
    ).toBeNull();
  });

  test("rejects a production application ID", () => {
    const error = validateSquareAccessToken("sq0idp-EXAMPLE");
    expect(error).toContain("application ID or secret");
  });

  test("rejects a production application secret", () => {
    const error = validateSquareAccessToken("sq0csp-EXAMPLE");
    expect(error).toContain("application ID or secret");
  });

  test("rejects a sandbox application ID", () => {
    const error = validateSquareAccessToken("sandbox-sq0idb-EXAMPLE");
    expect(error).toContain("application ID or secret");
  });

  test("rejects a value matching no known token format", () => {
    const error = validateSquareAccessToken("not-a-real-token");
    expect(error).toContain(SQUARE_ACCESS_TOKEN_PREFIX);
  });

  test("rejects a value with a valid prefix that is not anchored at the start", () => {
    const error = validateSquareAccessToken("junk-EAAAtoken");
    expect(error).toContain(SQUARE_ACCESS_TOKEN_PREFIX);
  });
});

describe("validateSquareLocationId", () => {
  test("accepts a normal location ID", () => {
    expect(validateSquareLocationId("LH182V1KBR6V2")).toBeNull();
  });

  test("accepts a fake-but-plausible location ID used in tests", () => {
    expect(validateSquareLocationId("L_test_456")).toBeNull();
  });

  test("rejects an application ID pasted into the location field", () => {
    const error = validateSquareLocationId("sq0idp-EXAMPLE");
    expect(error).toContain("not a Location ID");
  });
});

describe("validateSquareWebhookSignatureKey", () => {
  test("accepts a plausible signature key", () => {
    expect(validateSquareWebhookSignatureKey("aZ9_-realLookingKey")).toBeNull();
  });

  test("rejects an application ID pasted into the signature key field", () => {
    const error = validateSquareWebhookSignatureKey("sq0idp-EXAMPLE");
    expect(error).toContain("not a webhook signature key");
  });
});
