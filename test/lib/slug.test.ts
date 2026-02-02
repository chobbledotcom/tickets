import { describe, expect, test } from "#test-compat";
import { generateSlug } from "#lib/slug.ts";

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
});
