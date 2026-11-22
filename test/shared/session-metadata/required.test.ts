/** Which provider metadata is a checkout of ours: every value is text, and
 * it names a sealed order, or it carries a buyer and lines of its own. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hasRequiredSessionMetadata } from "#shared/session-metadata.ts";

describe("hasRequiredSessionMetadata", () => {
  test("returns false for null/undefined", () => {
    expect(hasRequiredSessionMetadata(null)).toBe(false);
    expect(hasRequiredSessionMetadata(undefined)).toBe(false);
  });

  test("returns false when name is missing or empty", () => {
    expect(hasRequiredSessionMetadata({ email: "a@b.com", items: "[]" })).toBe(
      false,
    );
    expect(
      hasRequiredSessionMetadata({
        email: "a@b.com",
        items: "[]",
        name: "",
      }),
    ).toBe(false);
  });

  test("returns false when items missing", () => {
    expect(
      hasRequiredSessionMetadata({ email: "a@b.com", name: "Alice" }),
    ).toBe(false);
  });

  test("returns true for valid single-listing (email optional)", () => {
    expect(hasRequiredSessionMetadata({ items: "[]", name: "Alice" })).toBe(
      true,
    );
    expect(
      hasRequiredSessionMetadata({ email: "", items: "[]", name: "Alice" }),
    ).toBe(true);
  });

  test("returns true for valid multi-listing metadata", () => {
    expect(
      hasRequiredSessionMetadata({
        email: "a@b.com",
        items: '[{"e":1,"q":2,"p":2000}]',
        name: "Alice",
      }),
    ).toBe(true);
  });

  test("returns false when a present metadata value is not text", () => {
    const fromProvider = JSON.parse(
      '{"email":123,"items":"[]","name":"Alice"}',
    );

    expect(hasRequiredSessionMetadata(fromProvider)).toBe(false);
  });

  test("returns true for a sealed order token with no buyer or lines", () => {
    expect(hasRequiredSessionMetadata({ bundle: "a-token" })).toBe(true);
    expect(hasRequiredSessionMetadata({ bundle: "" })).toBe(false);
  });
});
