import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  hasSimpleQuestionText,
  questionFieldset,
  questionTextContent,
  questionWrapper,
} from "#templates/components/question-text.tsx";
import { testAnswer, testQuestion } from "#test-utils";

const radioQuestion = (text: string): QuestionWithAnswers =>
  testQuestion({
    answers: [testAnswer({ id: 10, sort_order: 0, text: "Red" })],
    display_type: "radio",
    id: 1,
    text,
  });

describe("hasSimpleQuestionText", () => {
  test("true for plain text", () => {
    expect(hasSimpleQuestionText(radioQuestion("What size?"))).toBe(true);
  });

  test("false for bold markdown", () => {
    expect(hasSimpleQuestionText(radioQuestion("What **size**?"))).toBe(false);
  });

  test("false for multiple paragraphs", () => {
    expect(hasSimpleQuestionText(radioQuestion("Line 1\n\nLine 2"))).toBe(
      false,
    );
  });
});

describe("questionTextContent", () => {
  test("returns the raw text for simple markdown (JSX escapes it)", () => {
    const content = questionTextContent(radioQuestion("What size?"));
    // A plain string — JSX will escape it when rendered.
    expect(content).toBe("What size?");
  });

  test("returns a prose div with a stable id for complex markdown", () => {
    const content = String(
      questionTextContent(radioQuestion("What **size**?")),
    );
    expect(content).toContain('<div class="prose" id="question-1-prose">');
    expect(content).toContain("<strong>size</strong>");
  });
});

describe("questionWrapper", () => {
  test("wraps a control in a label for simple text", () => {
    const html = String(
      questionWrapper(radioQuestion("What size?"), undefined, () => (
        <input name="q1" type="text" />
      )),
    );
    expect(html).toContain('<label class="custom-question">');
    expect(html).toContain("What size?");
    expect(html).toContain('name="q1"');
    expect(html).toContain('type="text"');
  });

  test("does not pass a labelledBy id when the control is inside a label", () => {
    // Simple text labels the control implicitly via the wrapping <label>, so no
    // aria-labelledby is needed — the factory is called with no id.
    const html = String(
      questionWrapper(radioQuestion("What size?"), undefined, (labelledBy) => (
        <input aria-labelledby={labelledBy} name="q1" type="text" />
      )),
    );
    expect(html).not.toContain("aria-labelledby");
  });

  test("wraps a control in a div with prose for complex markdown", () => {
    const html = String(
      questionWrapper(radioQuestion("What **size**?"), "100 200", () => (
        <input name="q1" type="text" />
      )),
    );
    expect(html).toContain(
      '<div class="custom-question" data-listing-ids="100 200">',
    );
    expect(html).toContain('<div class="prose" id="question-1-prose">');
    expect(html).toContain("<strong>size</strong>");
    expect(html).not.toContain('<label class="custom-question">');
  });

  test("names the control via aria-labelledby for complex markdown", () => {
    // The control sits outside any <label>, so it must reference the prose id to
    // stay named for assistive tech.
    const html = String(
      questionWrapper(
        radioQuestion("What **size**?"),
        undefined,
        (labelledBy) => (
          <input aria-labelledby={labelledBy} name="q1" type="text" />
        ),
      ),
    );
    expect(html).toContain('aria-labelledby="question-1-prose"');
    expect(html).toContain('<div class="prose" id="question-1-prose">');
  });
});

describe("questionFieldset", () => {
  test("wraps controls in a fieldset with a legend for simple text", () => {
    const html = String(
      questionFieldset(radioQuestion("What size?"), undefined, [
        <label>
          <input name="q1" type="radio" value="small" /> Small
        </label>,
      ]),
    );

    expect(html).toContain('<fieldset class="custom-question">');
    expect(html).toContain("<legend>What size?</legend>");
    expect(html).toContain('type="radio"');
    expect(html).not.toContain('<div class="prose">');
    expect(html).not.toContain("aria-labelledby");
  });

  test("renders complex fieldset text as prose and names the group by it", () => {
    const html = String(
      questionFieldset(radioQuestion("What **size**?"), "100 200", [
        <label>
          <input name="q1" type="radio" value="small" /> Small
        </label>,
      ]),
    );

    expect(html).toContain(
      '<fieldset aria-labelledby="question-1-prose" class="custom-question" data-listing-ids="100 200">',
    );
    expect(html).toContain('<div class="prose" id="question-1-prose">');
    expect(html).toContain("<strong>size</strong>");
    expect(html).not.toContain("<legend>");
  });
});
