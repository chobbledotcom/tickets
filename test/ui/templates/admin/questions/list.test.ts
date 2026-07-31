import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminQuestionsPage } from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { testAnswer, testQuestion } from "#test-utils/factories.ts";
import { setupQuestionPageTest } from "./fixtures.ts";

describe("adminQuestionsPage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const colourQuestion = testQuestion({
    answers: [
      testAnswer({ id: 10, sort_order: 0, text: "Red" }),
      testAnswer({ id: 11, sort_order: 1, text: "Blue" }),
    ],
    id: 1,
    text: "Favourite colour?",
  });

  test("renders empty state when no questions", () => {
    const html = adminQuestionsPage([], OWNER_SESSION);
    expect(html).toContain("<p><em>No custom questions yet.</em></p>");
  });

  test("removes the Custom questions heading", () => {
    expect(adminQuestionsPage([], OWNER_SESSION)).not.toContain("<h1");
  });

  test("renders questions in a table with the answer count", () => {
    const html = adminQuestionsPage([colourQuestion], OWNER_SESSION);
    expect(html).toContain("<table");
    expect(html).toContain("Favourite colour?");
    // Answer-count cell shows the raw number.
    expect(html).toContain('<td class="col-quantity">2</td>');
  });

  test("shows a Listings count with the listing names as the cell title", () => {
    const html = adminQuestionsPage(
      [colourQuestion],
      OWNER_SESSION,
      undefined,
      new Map([[1, ["Spring Gig", "Summer Gig"]]]),
      5,
    );
    expect(html).toContain(
      '<td class="col-quantity" title="Spring Gig, Summer Gig">2</td>',
    );
  });

  test("shows All and the total count for assign-all questions", () => {
    const html = adminQuestionsPage(
      [{ ...colourQuestion, assign_all: true }],
      OWNER_SESSION,
      undefined,
      new Map(),
      5,
    );
    expect(html).toContain('<td class="col-quantity" title="All">5</td>');
  });

  test("defaults the assign-all count to zero when no total is passed", () => {
    // Called without a `totalListings` argument, an assign-all question's cell
    // must read the 0 default — not 1 — so a drift in that default parameter is
    // caught rather than silently over-reporting the listing count.
    const html = adminQuestionsPage(
      [{ ...colourQuestion, assign_all: true }],
      OWNER_SESSION,
    );
    expect(html).toContain('<td class="col-quantity" title="All">0</td>');
  });

  test("marks the questions nav entry active", () => {
    const html = adminQuestionsPage([colourQuestion], OWNER_SESSION);
    expect(html).toContain('class="active" href="/admin/questions"');
  });

  test("renders the add-question form", () => {
    const html = adminQuestionsPage([colourQuestion], OWNER_SESSION);
    expect(html).toContain(
      '<form action="/admin/questions" autocomplete="off" method="POST" id="new-question">',
    );
  });

  test("links to the questions guide", () => {
    const html = adminQuestionsPage([colourQuestion], OWNER_SESSION);
    expect(html).toContain(
      '<a class="guide-link" href="/admin/guide#questions">',
    );
    // The guide link carries its "Questions guide" label, not just the href —
    // a blanked label would still leave the anchor above. The label renders in
    // its own <span> (after the icon), so assert it there rather than as loose
    // page text that unrelated copy could satisfy.
    expect(html).toContain("<span>Questions guide</span>");
  });

  test("renders reorder controls: down on the first, up on the last", () => {
    const html = adminQuestionsPage(
      [
        testQuestion({
          answers: [testAnswer({ id: 10, text: "A" })],
          id: 1,
          text: "First Q",
        }),
        testQuestion({
          answers: [testAnswer({ id: 20, question_id: 2, text: "B" })],
          id: 2,
          text: "Second Q",
        }),
      ],
      OWNER_SESSION,
    );
    // First question: down button, but no up button.
    expect(html).toContain("/admin/questions/1/move-down");
    expect(html).not.toContain("/admin/questions/1/move-up");
    // Last question: up button, but no down button.
    expect(html).toContain("/admin/questions/2/move-up");
    expect(html).not.toContain("/admin/questions/2/move-down");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionsPage([], OWNER_SESSION, "Something went wrong");
    expect(html).toContain("Something went wrong");
  });

  test("keeps the list readable without write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionsPage([colourQuestion], OWNER_SESSION);
    expect(html).toContain("Favourite colour?");
    expect(html).toContain('href="/admin/questions/1"');
    expect(html).not.toContain('id="new-question"');
    expect(html).not.toContain("/admin/questions/1/move-");
  });
});
