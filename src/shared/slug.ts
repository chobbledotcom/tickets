/**
 * Slug utilities for URL-friendly identifiers
 *
 * Slugs are auto-generated 5-character strings from the alphabet
 * 0123456789abcdefgh (18 chars). Each slug must contain at least
 * 2 digits and 2 letters, giving ~1.15M possible combinations.
 */

import * as v from "valibot";

const DIGITS = "0123456789";
const LETTERS = "abcdefgh";
const ALPHABET = DIGITS + LETTERS;

/** Pick a random character from a string */
const randomChar = (chars: string): string =>
  chars[Math.floor(Math.random() * chars.length)]!;

/**
 * Generate a random slug with at least 2 digits and 2 letters.
 * Uses Fisher-Yates shuffle on the fixed positions to avoid bias.
 */
export const generateSlug = (): string => {
  // Start with guaranteed minimums
  const chars: string[] = [
    randomChar(DIGITS),
    randomChar(DIGITS),
    randomChar(LETTERS),
    randomChar(LETTERS),
    randomChar(ALPHABET),
  ];

  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
};

/** Normalize a user-provided slug: trim, lowercase, replace spaces with hyphens */
export const normalizeSlug = (input: string): string =>
  input.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Valid slug schema: non-empty, lowercase alphanumeric segments joined by
 * single hyphens or underscores (valibot's canonical slug form). The same
 * shape gates URL routing (router.ts) and embeddable paths (middleware.ts).
 */
const SlugSchema = v.pipe(
  v.string(),
  v.nonEmpty("Slug is required"),
  v.slug(
    "Slug must be lowercase letters and numbers separated by single hyphens or underscores",
  ),
);

/** Run a valibot schema with abortPipeEarly and return the first error message or null. */
export const firstIssueMessage = <T>(
  schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
  value: unknown,
): string | null => {
  const result = v.safeParse(schema, value, { abortPipeEarly: true });
  return result.success ? null : result.issues[0].message;
};

/** Validate a normalized slug. Returns error message or null. */
export const validateSlug = (slug: string): string | null =>
  firstIssueMessage(SlugSchema, slug);

/** Slug-with-index pair */
export type SlugWithIndex = { slug: string; slugIndex: string };

/**
 * Generate a unique slug by retrying until one is not taken.
 * @param computeIndex - hash the slug for blind-index lookup
 * @param isTaken - check cross-table uniqueness
 */
export const generateUniqueSlug = async (
  computeIndex: (slug: string) => Promise<string>,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<SlugWithIndex> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = generateSlug();
    const slugIndex = await computeIndex(slug);
    if (!(await isTaken(slug))) return { slug, slugIndex };
  }
  throw new Error("Failed to generate unique slug after 10 attempts");
};
