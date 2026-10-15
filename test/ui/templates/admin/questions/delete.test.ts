import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminAnswerDeletePage,
  adminQuestionDeletePage,
} from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testAnswer, testQuestion } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";
import { setupQuestionPageTest, tShirtQuestion } from "./fixtures.ts";

describe("adminQuestionDeletePage", () => {
  const question = testQuestion({
    answers: [testAnswer({ id: 10, sort_order: 0, text: "Small" })],
    id: 1,
    text: "T-shirt size?",
  });

  /** The confirmation page with no error, rendered once for the tests below. */
  let html = "";

  beforeAll(async () => {
    await setupQuestionPageTest();
    html = adminQuestionDeletePage(question, OWNER_SESSION);
  });
  afterAll(resetFeaturePageTest);

  test("renders confirmation form with question text", () => {
    says(html, "Delete question");
    says(html, "T-shirt size?");
    says(html, 'name="confirm_identifier"');
    says(html, 'action="/admin/questions/1/delete"');
    says(html, 'class="active" href="/admin/questions"');
  });

  test("warns about cascading deletes", () => {
    says(html, "all its answers");
    says(html, "attendee responses");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionDeletePage(
      question,
      OWNER_SESSION,
      "Text does not match",
    );
    says(html, "Text does not match");
  });
});

describe("adminAnswerDeletePage", () => {
  const question = tShirtQuestion;
  const answer = question.answers[0]!;

  /** The confirmation page with no error, rendered once for the tests below. */
  let html = "";

  beforeAll(async () => {
    await setupQuestionPageTest();
    html = adminAnswerDeletePage(question, answer, OWNER_SESSION);
  });
  afterAll(resetFeaturePageTest);

  test("renders confirmation form with answer text", () => {
    says(html, "Delete answer");
    says(html, "Small");
    says(html, 'name="confirm_identifier"');
    says(html, 'action="/admin/questions/1/answers/10/delete"');
  });

  test("shows question context", () => {
    says(html, "T-shirt size?");
  });

  test("renders error message when provided", () => {
    const html = adminAnswerDeletePage(
      question,
      answer,
      OWNER_SESSION,
      "Text does not match",
    );
    says(html, "Text does not match");
  });
});
