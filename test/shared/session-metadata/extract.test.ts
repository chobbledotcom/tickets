/** Provider metadata read into the one shape that the app uses: a field
 * that is present keeps its value, and an absent field reads as "". */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractSessionMetadata } from "#shared/session-metadata.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";

describe("extractSessionMetadata", () => {
  test("keeps present fields, and reads absent ones as empty", () => {
    const withFields = extractSessionMetadata(
      wireMetadata({
        email: "alice@example.com",
        items: "[]",
        name: "Alice",
        phone: "+1234567890",
      }),
    );
    expect(withFields.email).toBe("alice@example.com");
    expect(withFields.phone).toBe("+1234567890");
    expect(withFields.address).toBe("");

    const minimal = extractSessionMetadata(wireMetadata({ name: "Eve" }));
    expect(minimal.email).toBe("");
    expect(minimal.phone).toBe("");
    expect(minimal._origin).toBe("");
  });

  test("keeps day_count", () => {
    const extracted = extractSessionMetadata(
      wireMetadata({
        day_count: "3",
        email: "x@x.com",
        items: "[]",
        name: "X",
      }),
    );
    expect(extracted.day_count).toBe("3");
  });

  test("keeps site_token_index when present", () => {
    const extracted = extractSessionMetadata(
      wireMetadata({
        email: "renew@example.com",
        items: "[]",
        name: "Renewer",
        site_token_index: "hashed-index-value",
      }),
    );
    expect(extracted.site_token_index).toBe("hashed-index-value");
  });

  test("reads an absent site_token_index as empty", () => {
    const extracted = extractSessionMetadata(
      wireMetadata({ email: "x@x.com", items: "[]", name: "X" }),
    );
    expect(extracted.site_token_index).toBe("");
  });
});
