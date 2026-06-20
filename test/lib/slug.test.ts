import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  generateSlug,
  generateUniqueSlug,
  normalizeSlug,
  validateSlug,
} from "#shared/slug.ts";

describe("slug", () => {
  describe("generateSlug", () => {
    test("generates 5-character slugs", () => {
      const slug = generateSlug();
      expect(slug.length).toBe(5);
    });

    test("generates slugs using only digits and lowercase letters a-h", () => {
      for (let i = 0; i < 50; i++) {
        const slug = generateSlug();
        expect(slug).toMatch(/^[0-9a-h]{5}$/);
      }
    });

    test("generates slugs with at least 2 digits and 2 letters", () => {
      for (let i = 0; i < 50; i++) {
        const slug = generateSlug();
        const digitCount = slug.replace(/[^0-9]/g, "").length;
        const letterCount = slug.replace(/[^a-h]/g, "").length;
        expect(digitCount).toBeGreaterThanOrEqual(2);
        expect(letterCount).toBeGreaterThanOrEqual(2);
      }
    });

    test("generates different slugs on multiple calls", () => {
      const slugs = new Set<string>();
      for (let i = 0; i < 20; i++) {
        slugs.add(generateSlug());
      }
      // With ~1.15M combinations, 20 slugs should all be unique
      expect(slugs.size).toBe(20);
    });
  });

  describe("generateUniqueSlug", () => {
    test("throws after exhausting all retry attempts", async () => {
      const alwaysTaken = () => Promise.resolve(true);
      const computeIndex = (s: string) => Promise.resolve(s);
      await expect(
        generateUniqueSlug(computeIndex, alwaysTaken),
      ).rejects.toThrow("Failed to generate unique slug after 10 attempts");
    });
  });

  describe("normalizeSlug", () => {
    test("trims whitespace", () => {
      expect(normalizeSlug("  hello  ")).toBe("hello");
    });

    test("converts to lowercase", () => {
      expect(normalizeSlug("Hello-World")).toBe("hello-world");
    });

    test("replaces spaces with hyphens", () => {
      expect(normalizeSlug("my listing name")).toBe("my-listing-name");
    });

    test("replaces multiple spaces with single hyphen", () => {
      expect(normalizeSlug("my   listing")).toBe("my-listing");
    });

    test("handles combined transformations", () => {
      expect(normalizeSlug("  My Listing Name  ")).toBe("my-listing-name");
    });

    test("is idempotent for representative user-entered names", () => {
      const examples = [
        "  Summer Gala  ",
        "Already-normal",
        "multiple   spaces",
        "MIXED_case  Name",
      ];

      for (const example of examples) {
        const once = normalizeSlug(example);
        expect(normalizeSlug(once)).toBe(once);
      }
    });
  });

  describe("validateSlug", () => {
    const INVALID_SLUG_MESSAGE =
      "Slug must be lowercase letters and numbers separated by single hyphens or underscores";

    test("returns null for valid slug", () => {
      expect(validateSlug("my-listing-123")).toBeNull();
    });

    test("returns null for slug with only letters", () => {
      expect(validateSlug("mylisting")).toBeNull();
    });

    test("returns null for slug with only numbers", () => {
      expect(validateSlug("12345")).toBeNull();
    });

    test("returns null for slug with hyphens", () => {
      expect(validateSlug("my-listing")).toBeNull();
    });

    test("returns null for slug with underscores", () => {
      expect(validateSlug("my_listing")).toBeNull();
    });

    test("returns error for empty slug", () => {
      expect(validateSlug("")).toBe("Slug is required");
    });

    test("returns error for slug with uppercase letters", () => {
      expect(validateSlug("My-Listing")).toBe(INVALID_SLUG_MESSAGE);
    });

    test("returns error for slug with spaces", () => {
      expect(validateSlug("my listing")).toBe(INVALID_SLUG_MESSAGE);
    });

    test("returns error for slug with special characters", () => {
      expect(validateSlug("my-listing!")).toBe(INVALID_SLUG_MESSAGE);
    });

    test("returns error for slug with a leading hyphen", () => {
      expect(validateSlug("-my-listing")).toBe(INVALID_SLUG_MESSAGE);
    });

    test("returns error for slug with a trailing hyphen", () => {
      expect(validateSlug("my-listing-")).toBe(INVALID_SLUG_MESSAGE);
    });

    test("returns error for slug with consecutive separators", () => {
      expect(validateSlug("my--listing")).toBe(INVALID_SLUG_MESSAGE);
    });
  });
});
