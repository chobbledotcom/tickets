import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderReviewsJson } from "#scripts/reviews/render.ts";
import { frontmatterBlock, markdownFrontmatter } from "#shared/frontmatter.ts";
import { parseReviewsSource } from "#shared/reviews/parse.ts";

const SOURCE = "content/reviews.md";

const document = (reviews: string, body = ""): string =>
  `---\nreviews:\n${reviews}\n---\n${body}`;

const ONE_REVIEW = document(
  `  - name: "Jane Smith"
    rating: 4
    date: "2024-11-20"
    text: "Good service."`,
);

describe("the reviews source", () => {
  test("splits a markdown file into its frontmatter and body", () => {
    expect(markdownFrontmatter("---\na: 1\n---\nBody\n")).toEqual({
      body: "Body\n",
      frontmatter: "a: 1",
    });
    expect(frontmatterBlock("---\na: 1\n---\nBody")).toBe("a: 1");
    expect(markdownFrontmatter("No fence")).toBeNull();
    expect(frontmatterBlock("No fence")).toBeNull();
  });
  test("reads the reviews and the page introduction", () => {
    expect(parseReviewsSource(SOURCE, ONE_REVIEW)).toEqual({
      intro: "",
      reviews: [
        {
          date: "2024-11-20",
          name: "Jane Smith",
          rating: 4,
          text: "Good service.",
        },
      ],
    });
  });

  test("sorts reviews newest first", () => {
    const page = parseReviewsSource(
      SOURCE,
      document(
        `  - name: "Older"
    rating: 3
    date: "2024-01-02"
    text: "Older review."
  - name: "Newer"
    rating: 5
    date: "2026-03-04"
    text: "Newer review."`,
        "Read this first.",
      ),
    );
    expect(page.intro).toBe("Read this first.");
    expect(page.reviews.map((review) => review.name)).toEqual([
      "Newer",
      "Older",
    ]);
  });

  test("keeps an optional review URL", () => {
    const page = parseReviewsSource(
      SOURCE,
      document(
        `  - name: "Jane Smith"
    rating: 5
    date: "2024-11-20"
    url: "https://www.google.com/maps/reviews/1"
    text: "Great."`,
      ),
    );
    expect(page.reviews[0]?.url).toBe("https://www.google.com/maps/reviews/1");
  });

  test("writes the generated module as JSON", () => {
    const page = parseReviewsSource(SOURCE, ONE_REVIEW);
    expect(JSON.parse(renderReviewsJson(ONE_REVIEW, page))).toEqual({
      page,
      source: ONE_REVIEW,
    });
  });
});

describe("a malformed reviews source", () => {
  const cases: readonly [string, string, string][] = [
    ["no frontmatter", "Just text.", "no frontmatter block"],
    [
      "unparseable frontmatter",
      "---\nreviews: [\n---\n",
      "unparseable frontmatter",
    ],
    ["no reviews", document("  []"), "reviews"],
    [
      "a rating below one",
      document(
        `  - name: "Jane"\n    rating: 0\n    date: "2024-11-20"\n    text: "Bad."`,
      ),
      "rating",
    ],
    [
      "a rating above five",
      document(
        `  - name: "Jane"\n    rating: 6\n    date: "2024-11-20"\n    text: "Bad."`,
      ),
      "rating",
    ],
    [
      "a fractional rating",
      document(
        `  - name: "Jane"\n    rating: 4.5\n    date: "2024-11-20"\n    text: "Bad."`,
      ),
      "rating",
    ],
    [
      "a blank name",
      document(
        `  - name: " "\n    rating: 4\n    date: "2024-11-20"\n    text: "Bad."`,
      ),
      "name",
    ],
    [
      "a blank review",
      document(
        `  - name: "Jane"\n    rating: 4\n    date: "2024-11-20"\n    text: " "`,
      ),
      "text",
    ],
    [
      "a date that never happened",
      document(
        `  - name: "Jane"\n    rating: 4\n    date: "2024-02-31"\n    text: "Bad."`,
      ),
      "Date is not a real calendar day",
    ],
    [
      "an unsafe review URL",
      document(
        `  - name: "Jane"\n    rating: 4\n    date: "2024-11-20"\n    url: "ftp://example.com"\n    text: "Bad."`,
      ),
      "http",
    ],
  ];

  for (const [name, text, message] of cases) {
    test(`refuses ${name}`, () => {
      expect(() => parseReviewsSource(SOURCE, text)).toThrow(
        new RegExp(`${SOURCE}.*${message}`, "s"),
      );
    });
  }
});

describe("the committed reviews data", () => {
  test("matches the markdown source (run deno task reviews:generate)", async () => {
    const source = await Deno.readTextFile(SOURCE);
    const generated = await Deno.readTextFile(
      "src/shared/reviews.generated.json",
    );
    expect(generated).toBe(
      renderReviewsJson(source, parseReviewsSource(SOURCE, source)),
    );
  });
});
