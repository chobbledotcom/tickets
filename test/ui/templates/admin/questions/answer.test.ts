import { assert, assertStringIncludes } from "@std/assert";
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
  const question = tShirtQuestion;
  const answer = question.answers[1]!;
  const modifiers = [
    { id: 5, name: "Large surcharge" },
    { id: 6, name: "Tiny discount" },
  ];
  const aligned = { times_selected: { current: 7, recalculated: 7 } };
  const drifted = { times_selected: { current: 7, recalculated: 5 } };

  /** The page for an active answer whose stored total matches the attendee
   *  answers — the default most tests below assert against. Rendered once. */
  let html = "";

  beforeAll(async () => {
    await setupQuestionPageTest();
    html = adminAnswerEditPage(
      question,
      answer,
      OWNER_SESSION,
      undefined,
      aligned,
      modifiers,
      null,
    );
  });
  afterAll(resetFeaturePageTest);

  test("renders the editable text pre-filled and the form action", () => {
    assertStringIncludes(html, 'action="/admin/questions/1/answers/11/edit"');
    assertStringIncludes(html, 'value="Large"');
    assertStringIncludes(html, 'class="active" href="/admin/questions"');
    // An active answer renders the box checked, as a checkbox valued "on", with
    // one space between the input and its "Active" label.
    assertStringIncludes(
      html,
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
    assertStringIncludes(html, 'name="active"');
    assert(!html.includes("checked"));
  });

  test("renders the editable selection total field with the stored value", () => {
    assertStringIncludes(html, 'name="times_selected"');
    assertStringIncludes(html, 'value="7"');
  });

  test("links back to the question", () => {
    assertStringIncludes(html, 'href="/admin/questions/1"');
    assertStringIncludes(html, "Back to question");
  });

  test("links to the recalculate flow", () => {
    assertStringIncludes(
      html,
      'href="/admin/questions/1/answers/11/recalculate"',
    );
  });

  test("shows no drift warning when the total matches attendee answers", () => {
    assert(!html.includes("expected-actual-notice"));
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
    assertStringIncludes(html, "expected-actual-notice");
    // Expected (rebuilt from attendee answers) then got (stored).
    assertStringIncludes(html, "<strong>5</strong>");
    assertStringIncludes(html, "<strong>7</strong>");
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
    assertStringIncludes(html, '<select id="modifier_id" name="modifier_id">');
    assertStringIncludes(html, "Large surcharge");
    assertStringIncludes(html, "Tiny discount");
    assertStringIncludes(html, '<option selected value="5">');
  });

  test("says beside the selector that only answer-triggered modifiers appear here", () => {
    // The selector omits Automatic and add-on modifiers; the hint is the
    // affordance that stops an operator reading that as a bug. The rendered
    // page escapes the copy's quotes, so match the quoteless sentence tail.
    assertStringIncludes(html, "Create one on the Modifiers page first.");
  });

  test("selects the none option when no modifier is linked", () => {
    assertStringIncludes(html, '<option selected value="">');
  });

  test("moves the delete action onto the edit page", () => {
    assertStringIncludes(
      html,
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
    assertStringIncludes(html, "Invalid modifier");
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
    assertStringIncludes(
      html,
      'action="/admin/questions/1/answers/11/recalculate"',
    );
    assertStringIncludes(html, 'class="active" href="/admin/questions"');
    assertStringIncludes(html, '<div class="table-scroll">');
    // Current (stored) and recalculated (from attendee answers) columns.
    assertStringIncludes(html, "<td>7</td>");
    assertStringIncludes(html, "<td>5</td>");
    assertStringIncludes(html, 'name="recalculate_fields"');
  });

  test("renders an error flash", () => {
    assertStringIncludes(
      adminAnswerRecalculatePage(
        question,
        answer,
        snapshot,
        OWNER_SESSION,
        "Choose at least one total to recalculate",
      ),
      "Choose at least one total to recalculate",
    );
  });

  test("renders a success flash", () => {
    assertStringIncludes(
      adminAnswerRecalculatePage(
        question,
        answer,
        snapshot,
        OWNER_SESSION,
        undefined,
        "Selection total recalculated",
      ),
      "Selection total recalculated",
    );
  });
});
