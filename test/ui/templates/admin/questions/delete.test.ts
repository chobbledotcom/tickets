import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminAnswerDeletePage,
  adminQuestionDeletePage,
} from "#templates/admin/questions.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testAnswer, testQuestion } from "#test-utils/factories.ts";
import { resetFeaturePageTest } from "../feature-page-test.ts";
import { setupQuestionPageTest, tShirtQuestion } from "./fixtures.ts";

describe("adminQuestionDeletePage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = testQuestion({
    answers: [testAnswer({ id: 10, sort_order: 0, text: "Small" })],
    id: 1,
    text: "T-shirt size?",
  });

  test("renders confirmation form with question text", () => {
    const html = adminQuestionDeletePage(question, OWNER_SESSION);
    expect(html).toContain("Delete Question");
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/delete"');
    expect(html).toContain('class="active" href="/admin/questions"');
  });

  test("warns about cascading deletes", () => {
    const html = adminQuestionDeletePage(question, OWNER_SESSION);
    expect(html).toContain("all its answers");
    expect(html).toContain("attendee responses");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionDeletePage(
      question,
      OWNER_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});

describe("adminAnswerDeletePage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;
  const answer = question.answers[0]!;

  test("renders confirmation form with answer text", () => {
    const html = adminAnswerDeletePage(question, answer, OWNER_SESSION);
    expect(html).toContain("Delete Answer");
    expect(html).toContain("Small");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/answers/10/delete"');
  });

  test("shows question context", () => {
    const html = adminAnswerDeletePage(question, answer, OWNER_SESSION);
    expect(html).toContain("T-shirt size?");
  });

  test("renders error message when provided", () => {
    const html = adminAnswerDeletePage(
      question,
      answer,
      OWNER_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});
