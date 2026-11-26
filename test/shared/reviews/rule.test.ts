import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { reviewRule } from "#shared/reviews/rule.ts";

const input = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-11-24",
  name: "Jane Smith",
  rating: 5,
  text: "A good review.",
  url: "https://x.co/jane",
  ...overrides,
});

const limits = { name: 10, text: 20 };

describe("the review rule", () => {
  test("accepts and trims a complete review", () => {
    expect(
      reviewRule(input({ name: " Jane ", text: " Good review. " }), limits),
    ).toEqual({
      ok: true,
      value: {
        date: "2026-11-24",
        name: "Jane",
        rating: 5,
        text: "Good review.",
        url: "https://x.co/jane",
      },
    });
  });

  const cases: readonly [string, Record<string, unknown>, string][] = [
    ["a blank name", { name: " " }, "nameRequired"],
    ["a long name", { name: "A long reviewer" }, "nameTooLong"],
    ["a low rating", { rating: 0 }, "ratingInvalid"],
    ["a high rating", { rating: 6 }, "ratingInvalid"],
    ["a fractional rating", { rating: 3.5 }, "ratingInvalid"],
    ["a bad date", { date: "2026-02-31" }, "dateInvalid"],
    ["blank text", { text: " " }, "textRequired"],
    ["long text", { text: "A review that is too long" }, "textTooLong"],
    ["a blank URL", { url: " " }, "urlRequired"],
    ["a non-web URL", { url: "ftp://x.co" }, "urlInvalid"],
    ["a malformed URL", { url: "not a url" }, "urlInvalid"],
    ["a long URL", { url: "https://example.com/reviews/long" }, "urlTooLong"],
  ];

  for (const [name, overrides, error] of cases) {
    test(`refuses ${name}`, () => {
      expect(reviewRule(input(overrides), limits)).toEqual({
        error,
        ok: false,
      });
    });
  }
});
