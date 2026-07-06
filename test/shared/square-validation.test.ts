import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  validateSquareAccessToken,
  validateSquareLocationId,
  validateSquareWebhookSignatureKey,
} from "#shared/square-validation.ts";

describe("validateSquareAccessToken", () => {
  test("accepts a current-style token with the EAAA prefix", () => {
    expect(validateSquareAccessToken("EAAAl_real_token")).toBeNull();
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

  test("rejects a sandbox application secret with the exact app-credential message", () => {
    expect(validateSquareAccessToken("sandbox-sq0csb-EXAMPLE")).toBe(
      `That looks like a Square application ID or secret (it starts with "sq0"), not an access token. Copy the Access Token from your Square application's Credentials page.`,
    );
  });

  test("rejects a value matching no known token format with the exact message", () => {
    expect(validateSquareAccessToken("not-a-real-token")).toBe(
      `That doesn't look like a Square access token. Access tokens start with "EAAA" or "eyJ". Please check you pasted the Access Token, not the Application ID or a webhook signature key.`,
    );
  });

  test("rejects a value with a valid prefix that is not anchored at the start", () => {
    const error = validateSquareAccessToken("junk-EAAAtoken");
    expect(error).toContain("EAAA");
  });
});

describe("validateSquareLocationId", () => {
  test("accepts a normal location ID", () => {
    expect(validateSquareLocationId("LH182V1KBR6V2")).toBeNull();
  });

  test("accepts a fake-but-plausible location ID used in tests", () => {
    expect(validateSquareLocationId("L_test_456")).toBeNull();
  });

  test("rejects an application ID pasted into the location field, with the example ID in the hint", () => {
    expect(validateSquareLocationId("sq0idp-EXAMPLE")).toBe(
      `That looks like a Square application ID or secret, not a Location ID. The Location ID is a short code like "LH182V1KBR6V2" found under Locations in your Square Dashboard.`,
    );
  });
});

describe("validateSquareWebhookSignatureKey", () => {
  test("accepts a plausible signature key", () => {
    expect(validateSquareWebhookSignatureKey("aZ9_-realLookingKey")).toBeNull();
  });

  test("rejects an application ID pasted into the signature key field, with the exact message", () => {
    expect(validateSquareWebhookSignatureKey("sq0idp-EXAMPLE")).toBe(
      "That looks like a Square application ID or secret, not a webhook signature key. Copy the Signature Key shown on your webhook subscription page in the Square Developer Dashboard.",
    );
  });
});
