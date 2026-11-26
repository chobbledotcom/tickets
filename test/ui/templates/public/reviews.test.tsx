import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Review, ReviewsPageData } from "#shared/reviews/schema.ts";
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
  name: "Jane Smith",
  rating: 4,
  text: "Great **service**.",
  ...overrides,
});

const page = (overrides: Partial<ReviewsPageData> = {}): ReviewsPageData => ({
  intro: "Read what our customers say.",
  reviews: [review()],
  ...overrides,
});

const body = (data: ReviewsPageData = page()): string =>
  String(reviewsBody(data, labels));

describe("the reviews page body", () => {
  test("renders the introduction, stars, date, body, avatar, and review link", () => {
    const html = body(
      page({
        reviews: [
          review({
            rating: 5,
            url: "https://www.google.com/maps/reviews/1",
          }),
        ],
      }),
    );

    expectIncludesAll(html, [
      '<div class="prose"><p>Read what our customers say.</p>',
      '<ul class="reviews-grid">',
      '<li class="review-card">',
      '<span class="rating">',
      '<span aria-hidden="true">★★★★★</span>',
      "Rated 5 out of 5 stars",
      '<time class="date" datetime="2024-11-20">when 2024-11-20</time>',
      "<strong>service</strong>",
      "JS",
      "Jane Smith",
      'href="https://www.google.com/maps/reviews/1"',
      'rel="nofollow noopener noreferrer"',
      "View on Google",
    ]);
  });

  test("uses a plain review link for a site that is not Google", () => {
    const html = body(
      page({ reviews: [review({ url: "https://example.com/a-review" })] }),
    );

    expectIncludesAll(html, [
      'href="https://example.com/a-review"',
      "View review",
    ]);
    assert(!html.includes("View on Google"));
  });

  test("shows no review link when the review has no address", () => {
    assert(!body().includes("review-link"));
  });

  test("omits an empty introduction", () => {
    assert(!body(page({ intro: "" })).includes('<div class="prose">'));
  });

  test("renders every review in the order it was given", () => {
    const html = body(
      page({
        reviews: [
          review({ name: "Newer Reviewer", text: "Newer words." }),
          review({ name: "Older Reviewer", text: "Older words." }),
        ],
      }),
    );

    expect(html.indexOf("Newer words.")).toBeLessThan(
      html.indexOf("Older words."),
    );
  });

  test("escapes raw HTML in a review", () => {
    const html = body(
      page({ reviews: [review({ text: "<script>x</script>" })] }),
    );

    assert(!html.includes("<script>"));
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("builds initials for one word and for several words", () => {
    expect(reviewerInitials("Alice")).toBe("AL");
    expect(reviewerInitials("Jane Smith")).toBe("JS");
    expect(reviewerInitials("Mary Jane Watson")).toBe("MW");
  });
});
