import { describe, expect, test } from "#test-compat";
import { generateSlug, normalizeSlug, validateSlug } from "#lib/slug.ts";

describe("slug", () => {
  describe("generateSlug", () => {
    test("generates 5-character slugs", () => {
      const slug = generateSlug();
      expect(slug.length).toBe(5);
    });

    test("generates slugs from valid alphabet", () => {
      const validChars = "0123456789abcdefgh";
      for (let i = 0; i < 50; i++) {
        const slug = generateSlug();
        for (const ch of slug) {
          expect(validChars.includes(ch)).toBe(true);
        }
      }
    });

    test("generates slugs with at least 2 digits and 2 letters", () => {
      const digits = "0123456789";
      const letters = "abcdefgh";
      for (let i = 0; i < 50; i++) {
        const slug = generateSlug();
        let digitCount = 0;
        let letterCount = 0;
        for (const ch of slug) {
          if (digits.includes(ch)) digitCount++;
          else if (letters.includes(ch)) letterCount++;
        }
        expect(digitCount >= 2).toBe(true);
        expect(letterCount >= 2).toBe(true);
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

  describe("normalizeSlug", () => {
    test("trims whitespace", () => {
      expect(normalizeSlug("  hello  ")).toBe("hello");
    });

    test("converts to lowercase", () => {
      expect(normalizeSlug("Hello-World")).toBe("hello-world");
    });

    test("replaces spaces with hyphens", () => {
      expect(normalizeSlug("my event name")).toBe("my-event-name");
    });

    test("replaces multiple spaces with single hyphen", () => {
      expect(normalizeSlug("my   event")).toBe("my-event");
    });

    test("handles combined transformations", () => {
      expect(normalizeSlug("  My Event Name  ")).toBe("my-event-name");
    });
  });

  describe("validateSlug", () => {
    test("returns null for valid slug", () => {
      expect(validateSlug("my-event-123")).toBeNull();
    });

    test("returns null for slug with only letters", () => {
      expect(validateSlug("myevent")).toBeNull();
    });

    test("returns null for slug with only numbers", () => {
      expect(validateSlug("12345")).toBeNull();
    });

    test("returns null for slug with hyphens", () => {
      expect(validateSlug("my-event")).toBeNull();
    });

    test("returns error for empty slug", () => {
      expect(validateSlug("")).toBe("Slug is required");
    });

    test("returns error for slug with uppercase letters", () => {
      expect(validateSlug("My-Event")).toBe(
        "Slug may only contain lowercase letters, numbers, and hyphens",
      );
    });

    test("returns error for slug with spaces", () => {
      expect(validateSlug("my event")).toBe(
        "Slug may only contain lowercase letters, numbers, and hyphens",
      );
    });

    test("returns error for slug with special characters", () => {
      expect(validateSlug("my_event!")).toBe(
        "Slug may only contain lowercase letters, numbers, and hyphens",
      );
    });
  });
});
