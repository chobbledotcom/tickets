import { describe, expect, test } from "#test-compat";
import { isValidSlug, generateSlug } from "#lib/slug.ts";

describe("slug", () => {
  describe("isValidSlug", () => {
    test("accepts valid 5-char slug with digits and letters", () => {
      expect(isValidSlug("ab12c")).toBe(true);
      expect(isValidSlug("01abc")).toBe(true);
      expect(isValidSlug("9a8bc")).toBe(true);
    });

    test("rejects slug with wrong length", () => {
      expect(isValidSlug("ab1c")).toBe(false);
      expect(isValidSlug("ab12cd")).toBe(false);
      expect(isValidSlug("")).toBe(false);
    });

    test("rejects slug with invalid characters", () => {
      expect(isValidSlug("ab12z")).toBe(false);
      expect(isValidSlug("AB12c")).toBe(false);
      expect(isValidSlug("ab-2c")).toBe(false);
    });

    test("rejects slug with fewer than 2 digits", () => {
      expect(isValidSlug("abcde")).toBe(false);
      expect(isValidSlug("abcd1")).toBe(false);
    });

    test("rejects slug with fewer than 2 letters", () => {
      expect(isValidSlug("12345")).toBe(false);
      expect(isValidSlug("1234a")).toBe(false);
    });

    test("accepts slug with exactly 2 digits and 2 letters", () => {
      expect(isValidSlug("12ab3")).toBe(true);
      expect(isValidSlug("a1b23")).toBe(true);
    });
  });

  describe("generateSlug", () => {
    test("generates a valid slug", () => {
      const slug = generateSlug();
      expect(isValidSlug(slug)).toBe(true);
    });

    test("generates 5-character slugs", () => {
      const slug = generateSlug();
      expect(slug.length).toBe(5);
    });

    test("generates different slugs on multiple calls", () => {
      const slugs = new Set<string>();
      for (let i = 0; i < 20; i++) {
        slugs.add(generateSlug());
      }
      // With ~1.15M combinations, 20 slugs should all be unique
      expect(slugs.size).toBe(20);
    });

    test("all generated slugs pass validation", () => {
      for (let i = 0; i < 50; i++) {
        const slug = generateSlug();
        expect(isValidSlug(slug)).toBe(true);
      }
    });
  });
});
