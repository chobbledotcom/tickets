/**
 * Slug utilities for URL-friendly identifiers
 *
 * Slugs are auto-generated 5-character strings from the alphabet
 * 0123456789abcdefgh (18 chars). Each slug must contain at least
 * 2 digits and 2 letters, giving ~1.15M possible combinations.
 */

import * as v from "valibot";
import { range } from "#fp";

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
  for (const i of range(1, chars.length).toReversed()) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
};

/** Normalize a user-provided slug: trim, lowercase, replace spaces with hyphens */
export const normalizeSlug = (input: string): string =>
  input.trim().toLowerCase().replace(/\s+/g, "-");

/** Turn arbitrary text into a URL slug: lowercase, every run of non
 * `[a-z0-9]` collapsed to a single hyphen, no leading/trailing hyphen. Shared
 * by the news permalink builder and the provider-resource slug. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

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

/** Slug-with-index pair. `Index` is the blind-index type `computeIndex`
 * produces (a `BlindIndex` for the real tables). */
export type SlugWithIndex<Index extends string = string> = {
  slug: string;
  slugIndex: Index;
};

/** Hash a slug into its blind-index (for blind-index lookups). */
type ComputeIndex<Index extends string> = (slug: string) => Promise<Index>;
/** Is this slug already taken (cross-table or within one table)? */
type IsTaken = (slug: string) => Promise<boolean>;

/** Try up to `maxAttempts` candidate slugs (`candidate(0)`, `candidate(1)`, …)
 * and return the first free one's {@link SlugWithIndex} — the blind index is
 * computed only for the slug that wins. Throws `exhausted()` if every candidate
 * is taken. The single retry loop behind both public generators below. */
const uniqueSlugFrom = async <Index extends string>(opts: {
  maxAttempts: number;
  candidate: (attempt: number) => string;
  computeIndex: ComputeIndex<Index>;
  isTaken: IsTaken;
  exhausted: () => string;
}): Promise<SlugWithIndex<Index>> => {
  for (const attempt of range(0, opts.maxAttempts)) {
    const slug = opts.candidate(attempt);
    if (!(await opts.isTaken(slug)))
      return { slug, slugIndex: await opts.computeIndex(slug) };
  }
  throw new Error(opts.exhausted());
};

/**
 * Generate a unique slug by retrying random slugs until one is not taken.
 * @param computeIndex - hash the slug for blind-index lookup
 * @param isTaken - check cross-table uniqueness
 */
export const generateUniqueSlug = <Index extends string>(
  computeIndex: ComputeIndex<Index>,
  isTaken: IsTaken,
): Promise<SlugWithIndex<Index>> =>
  uniqueSlugFrom({
    candidate: generateSlug,
    computeIndex,
    exhausted: () => "Failed to generate unique slug after 10 attempts",
    isTaken,
    maxAttempts: 10,
  });

/**
 * Make a deterministic `base` slug unique by appending `-2`, `-3`, … until one
 * is free. Unlike {@link generateUniqueSlug} (random 5-char slugs), this keeps
 * a human-readable base — the news permalink `yyyy-MM-dd-post-name` — and only
 * disambiguates on collision (two same-day posts with the same name).
 */
export const uniqueSlugFromBase = <Index extends string>(opts: {
  base: string;
  computeIndex: ComputeIndex<Index>;
  isTaken: IsTaken;
}): Promise<SlugWithIndex<Index>> =>
  uniqueSlugFrom({
    candidate: (attempt) =>
      attempt === 0 ? opts.base : `${opts.base}-${attempt + 1}`,
    computeIndex: opts.computeIndex,
    exhausted: () => `Failed to generate unique slug from base "${opts.base}"`,
    isTaken: opts.isTaken,
    maxAttempts: 100,
  });
