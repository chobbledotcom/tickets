import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encodedAfter } from "#shared/encoded-after.ts";

describe("shared > encoded-after", () => {
  const hrefFor = encodedAfter("/payment/success?session_id=");

  test("places the encoded value after the prefix", () => {
    expect(hrefFor("ses_123")).toBe("/payment/success?session_id=ses_123");
  });

  test("encodes a separator in the value so it stays one value", () => {
    expect(hrefFor("a&b=c")).toBe("/payment/success?session_id=a%26b%3Dc");
  });

  test("encodes a space as the URI escape", () => {
    expect(encodedAfter("q=")("big venue")).toBe("q=big%20venue");
  });
});
