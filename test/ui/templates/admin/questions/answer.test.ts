import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
} from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testAnswer, testQuestion } from "#test-utils/factories.ts";
import { setupQuestionPageTest, tShirtQuestion } from "./fixtures.ts";

describe("adminAnswerEditPage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;
  const answer = question.answers[1]!;
  const modifiers = [
    { id: 5, name: "Large surcharge" },
    { id: 6, name: "Tiny discount" },
  ];
  const aligned = { times_selected: { current: 7, recalculated: 7 } };
  const drifted = { times_selected: { current: 7, recalculated: 5 } };

  test("renders the editable text pre-filled and the form action", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('action="/admin/questions/1/answers/11/edit"');
    expect(html).toContain('value="Large"');
    expect(html).toContain('class="active" href="/admin/questions"');
    // An active answer renders the box checked, as a checkbox valued "on", with
    // one space between the input and its "Active" label.
    expect(html).toContain(
      '<input checked name="active" type="checkbox" value="on"> Active',
    );
  });

  test("renders the active box unchecked for a deactivated answer", () => {
    const html = adminAnswerEditPage(
      question,
      testAnswer({ active: false, id: 12, sort_order: 2, text: "Retired" }),
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('name="active"');
    expect(html).not.toContain("checked");
  });

  test("renders the editable selection total field with the stored value", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('name="times_selected"');
    expect(html).toContain('value="7"');
  });

  test("links back to the question", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('href="/admin/questions/1"');
    expect(html).toContain("Back to question");
  });

  test("links to the recalculate flow", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('href="/admin/questions/1/answers/11/recalculate"');
  });

  test("shows no drift warning when the total matches attendee answers", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).not.toContain("expected-actual-notice");
  });

  test("warns and shows expected/actual when the total has drifted", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      drifted,
      modifiers,
      null,
    );
    expect(html).toContain("expected-actual-notice");
    // Expected (rebuilt from attendee answers) then got (stored).
    expect(html).toContain("<strong>5</strong>");
    expect(html).toContain("<strong>7</strong>");
  });

  test("lists modifier options and marks the linked one selected", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      5,
    );
    expect(html).toContain('<select id="modifier_id" name="modifier_id">');
    expect(html).toContain("Large surcharge");
    expect(html).toContain("Tiny discount");
    expect(html).toContain('<option selected value="5">');
  });

  test("selects the none option when no modifier is linked", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain('<option selected value="">');
  });

  test("moves the delete action onto the edit page", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain(
      '<a class="danger" href="/admin/questions/1/answers/11/delete">',
    );
  });

  test("renders an error message when provided", () => {
    const html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      "Invalid modifier",
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain("Invalid modifier");
  });
});

describe("adminAnswerRecalculatePage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = testQuestion({
    answers: [testAnswer({ id: 11, sort_order: 1, text: "Large" })],
    id: 1,
    text: "T-shirt size?",
  });
  const answer = question.answers[0]!;
  const snapshot = { times_selected: { current: 7, recalculated: 5 } };

  test("renders the recalculate form for the answer", () => {
    const html = adminAnswerRecalculatePage(
      question,
      answer,
      snapshot,
      OWNER_SESSION,
    );
    expect(html).toContain(
      'action="/admin/questions/1/answers/11/recalculate"',
    );
    expect(html).toContain('class="active" href="/admin/questions"');
    expect(html).toContain('<div class="table-scroll">');
    // Current (stored) and recalculated (from attendee answers) columns.
    expect(html).toContain("<td>7</td>");
    expect(html).toContain("<td>5</td>");
    expect(html).toContain('name="recalculate_fields"');
  });

  test("renders error and success flashes", () => {
    expect(
      adminAnswerRecalculatePage(
        question,
        answer,
        snapshot,
        OWNER_SESSION,
        "Choose at least one total to recalculate",
      ),
    ).toContain("Choose at least one total to recalculate");
    expect(
      adminAnswerRecalculatePage(
        question,
        answer,
        snapshot,
        OWNER_SESSION,
        undefined,
        "Selection total recalculated",
      ),
    ).toContain("Selection total recalculated");
  });
});
