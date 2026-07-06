import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  generateSlug,
  generateUniqueSlug,
  normalizeSlug,
  slugify,
  uniqueSlugFromBase,
  validateSlug,
} from "#shared/slug.ts";

/** Feed a fixed sequence of Math.random() values, in order, to the body. */
const withRandomSequence = <T>(values: number[], body: () => T): T => {
  let index = 0;
  const randomStub = stub(Math, "random", () => values[index++]!);
  try {
    return body();
  } finally {
    randomStub.restore();
  }
};

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

    test("shuffles the guaranteed digits/letters via a real Fisher-Yates pass", () => {
      // Pins every Math.random() call the function makes: the 5 guaranteed
      // characters (digit, digit, letter, letter, any), then the 4 shuffle
      // swaps. This exact sequence starts as "37cfa" and the shuffle moves
      // every character at least once, so a broken swap index, a skipped
      // swap, or a wrong loop bound all produce a different result.
      const slug = withRandomSequence(
        [0.35, 0.75, 0.3, 0.7, 0.56, 0.1, 0.9, 0.5, 0.1],
        () => generateSlug(),
      );
      expect(slug).toBe("ca7f3");
    });
  });

  describe("generateUniqueSlug", () => {
    test("throws after exhausting all retry attempts", async () => {
      const alwaysTaken = () => Promise.resolve(true);
      const computeIndex = (s: string) => Promise.resolve(s);
      let error: Error | undefined;
      try {
        await generateUniqueSlug(computeIndex, alwaysTaken);
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toBe(
        "Failed to generate unique slug after 10 attempts",
      );
    });

    test("retries exactly 10 times before giving up, not more or fewer", async () => {
      let calls = 0;
      const alwaysTaken = () => {
        calls++;
        return Promise.resolve(true);
      };
      const computeIndex = (s: string) => Promise.resolve(s);
      await expect(
        generateUniqueSlug(computeIndex, alwaysTaken),
      ).rejects.toThrow();
      expect(calls).toBe(10);
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

  describe("slugify", () => {
    test("lowercases and collapses runs of non-alphanumerics to one hyphen", () => {
      expect(slugify("Big Launch!")).toBe("big-launch");
      expect(slugify("Tom & Jerry <launch>")).toBe("tom-jerry-launch");
      expect(slugify("a___b   c")).toBe("a-b-c");
    });

    test("trims leading and trailing hyphens; keeps digits and existing hyphens", () => {
      expect(slugify("  --Hello--  ")).toBe("hello");
      expect(slugify("2026-07-06-Big Launch")).toBe("2026-07-06-big-launch");
    });
  });

  describe("uniqueSlugFromBase", () => {
    const computeIndex = (slug: string): Promise<string> =>
      Promise.resolve(`idx:${slug}`);

    test("returns the base slug untouched when it is free", async () => {
      const result = await uniqueSlugFromBase({
        base: "2026-07-06-update",
        computeIndex,
        isTaken: () => Promise.resolve(false),
      });
      expect(result).toEqual({
        slug: "2026-07-06-update",
        slugIndex: "idx:2026-07-06-update",
      });
    });

    test("appends -2, -3, … until a free slug is found", async () => {
      const taken = new Set(["2026-07-06-update", "2026-07-06-update-2"]);
      const result = await uniqueSlugFromBase({
        base: "2026-07-06-update",
        computeIndex,
        isTaken: (slug) => Promise.resolve(taken.has(slug)),
      });
      expect(result.slug).toBe("2026-07-06-update-3");
    });

    test("throws when no free slug is found within the bound", async () => {
      await expect(
        uniqueSlugFromBase({
          base: "dupe",
          computeIndex,
          isTaken: () => Promise.resolve(true),
        }),
      ).rejects.toThrow('Failed to generate unique slug from base "dupe"');
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
