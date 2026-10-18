// Property tests for the slug utilities: for arbitrary input text, slugify
// always produces a URL-safe slug, is idempotent, and agrees with the
// normalizer; validateSlug accepts every non-empty slugify output. fast-check
// runs each property with a fixed seed and run count, so every run generates
// the same cases.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import { normalizeSlug, slugify, validateSlug } from "#shared/slug.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

/** The URL-safe shape the slug docs promise: lowercase alphanumerics in
 * single-hyphen runs, or the empty string. */
const URL_SAFE = /^([a-z0-9]+(-[a-z0-9]+)*)?$/;

describe("slugify properties", () => {
  test("always returns a URL-safe slug or the empty string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        expect(slugify(text)).toMatch(URL_SAFE);
      }),
      seedArgs,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const once = slugify(text);
        expect(slugify(once)).toBe(once);
      }),
      seedArgs,
    );
  });

  test("agrees with normalizeSlug for every input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        expect(slugify(normalizeSlug(text))).toBe(slugify(text));
      }),
      seedArgs,
    );
  });

  test("validateSlug accepts every non-empty slugify output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const slug = slugify(text);
        if (slug !== "") {
          expect(validateSlug(slug)).toBeNull();
        }
      }),
      seedArgs,
    );
  });
});
