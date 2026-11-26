import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Review } from "#shared/reviews/types.ts";
import {
  type ReviewsLabels,
  reviewerInitials,
  reviewsBody,
} from "#templates/public/reviews-body.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const labels: ReviewsLabels = {
  date: (date) => `when ${date}`,
  rating: (rating) => `Rated ${rating} out of 5 stars`,
  viewOnGoogle: "View on Google",
  viewReview: "View review",
};

const review = (overrides: Partial<Review> = {}): Review => ({
  date: "2024-11-20",
  id: 1,
  name: "Jane Smith",
  rating: 4,
  text: "Great **service**.",
  url: "https://example.com/a-review",
  urlIndex: "index" as Review["urlIndex"],
  ...overrides,
});

const body = (reviews: readonly Review[] = [review()]): string =>
  String(reviewsBody(reviews, labels));

describe("the reviews page body", () => {
  test("renders stars, date, body, avatar, and review link", () => {
    const html = body([
      review({
        rating: 5,
        url: "https://www.google.com/maps/reviews/1",
      }),
    ]);

    expectIncludesAll(html, [
      '<ul class="reviews-grid">',
      '<li class="review-card">',
      '<span class="rating">',
      '<span aria-hidden="true">★★★★★</span>',
      "Rated 5 out of 5 stars",
      '<time class="date" datetime="2024-11-20">when 2024-11-20</time>',
    ]);
    expectIncludesAll(html, [
      "<strong>service</strong>",
      "JS",
      "Jane Smith",
      'href="https://www.google.com/maps/reviews/1"',
      'rel="nofollow noopener noreferrer"',
      "View on Google",
    ]);
  });

  test("uses a plain review link for a site that is not Google", () => {
    const html = body();

    expectIncludesAll(html, ["View review"]);
    assert(!html.includes("View on Google"));
  });

  test("renders every review in the order it was given", () => {
    const html = body([
      review({ name: "Newer Reviewer", text: "Newer words." }),
      review({ id: 2, name: "Older Reviewer", text: "Older words." }),
    ]);

    expect(html.indexOf("Newer words.")).toBeLessThan(
      html.indexOf("Older words."),
    );
  });

  test("escapes raw HTML in a review", () => {
    const html = body([review({ text: "<script>x</script>" })]);

    assert(!html.includes("<script>"));
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("builds initials for one word and for several words", () => {
    const cases = [
      ["Alice", "AL"],
      ["Jane Smith", "JS"],
      ["Mary Jane Watson", "MW"],
    ] as const;
    for (const [name, initials] of cases) {
      expect(reviewerInitials(name)).toBe(initials);
    }
  });
});
