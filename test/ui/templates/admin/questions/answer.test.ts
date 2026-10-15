import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
} from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testAnswer, testQuestion } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";
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
    says(html, 'action="/admin/questions/1/answers/11/edit"');
    says(html, 'value="Large"');
    says(html, 'class="active" href="/admin/questions"');
    // An active answer renders the box checked, as a checkbox valued "on", with
    // one space between the input and its "Active" label.
    says(
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
    says(html, 'name="active"');
    assert(!html.includes("checked"));
  });

  test("renders the editable selection total field with the stored value", () => {
    says(html, 'name="times_selected"');
    says(html, 'value="7"');
  });

  test("links back to the question", () => {
    says(html, 'href="/admin/questions/1"');
    says(html, "Back to question");
  });

  test("links to the recalculate flow", () => {
    says(html, 'href="/admin/questions/1/answers/11/recalculate"');
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
    says(html, "expected-actual-notice");
    // Expected (rebuilt from attendee answers) then got (stored).
    says(html, "<strong>5</strong>");
    says(html, "<strong>7</strong>");
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
    says(html, '<select id="modifier_id" name="modifier_id">');
    says(html, "Large surcharge");
    says(html, "Tiny discount");
    says(html, '<option selected value="5">');
  });

  test("says beside the selector that only answer-triggered modifiers appear here", () => {
    // The selector omits Automatic and add-on modifiers; the hint is the
    // affordance that stops an operator reading that as a bug. The rendered
    // page escapes the copy's quotes, so match the quoteless sentence tail.
    says(html, "Create one on the Modifiers page first.");
  });

  test("selects the none option when no modifier is linked", () => {
    says(html, '<option selected value="">');
  });

  test("moves the delete action onto the edit page", () => {
    says(
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
    says(html, "Invalid modifier");
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
    says(html, 'action="/admin/questions/1/answers/11/recalculate"');
    says(html, 'class="active" href="/admin/questions"');
    says(html, '<div class="table-scroll">');
    // Current (stored) and recalculated (from attendee answers) columns.
    says(html, "<td>7</td>");
    says(html, "<td>5</td>");
    says(html, 'name="recalculate_fields"');
  });

  test("renders an error flash", () => {
    says(
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
    says(
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
