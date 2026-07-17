import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ListingOverviewPanel,
  overviewStatsFromAttendees,
} from "#templates/admin/listings/overview.tsx";
import {
  adminAnswerDeletePage,
  adminAnswerEditPage,
  adminAnswerRecalculatePage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
  ListingQuestionsPanel,
  questionTextFlat,
} from "#templates/admin/questions.tsx";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import {
  singleAnswerSizeQuestionData,
  smallLargeAnswers,
  testAnswer,
  testListingWithCount,
  testQuestion,
} from "#test-utils/factories.ts";
import { featureSetting } from "#test-utils/settings.ts";

const TEST_LISTINGS = [
  testListingWithCount({ id: 1, name: "Spring Gig" }),
  testListingWithCount({ id: 2, name: "Summer Gig" }),
];

const TEST_SESSION = { adminLevel: "owner" as const };

/** The "T-shirt size?" question with Small/Large answers — the canonical radio
 *  question reused by the question, answer-edit, and answer-delete page tests.
 *  Built once so each describe shares the same fixture instead of re-spelling
 *  the literal three times. */
const tShirtQuestion = testQuestion({
  answers: smallLargeAnswers,
  id: 1,
  text: "T-shirt size?",
});

beforeAll(async () => {
  setupTestEncryptionKey();
  settings.setForTest(featureSetting("questions"));
  await signCsrfToken();
});

afterAll(() => {
  settings.clearTestOverride("enabled_features");
});

describe("adminQuestionsPage", () => {
  const colourQuestion = testQuestion({
    answers: [
      testAnswer({ id: 10, sort_order: 0, text: "Red" }),
      testAnswer({ id: 11, sort_order: 1, text: "Blue" }),
    ],
    id: 1,
    text: "Favourite colour?",
  });

  test("renders empty state when no questions", () => {
    const html = adminQuestionsPage([], TEST_SESSION);
    expect(html).toContain("No custom questions yet");
  });

  test("removes the Custom Questions heading", () => {
    expect(adminQuestionsPage([], TEST_SESSION)).not.toContain("<h1");
  });

  test("renders questions in a table with the answer count", () => {
    const html = adminQuestionsPage([colourQuestion], TEST_SESSION);
    expect(html).toContain("<table");
    expect(html).toContain("Favourite colour?");
    // Answer-count cell shows the raw number.
    expect(html).toContain('<td class="col-quantity">2</td>');
  });

  test("shows a Listings count with the listing names as the cell title", () => {
    const html = adminQuestionsPage(
      [colourQuestion],
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
    );
    expect(html).toContain('<td class="col-quantity" title="All">0</td>');
  });

  test("marks the nav active, renders the add form, and links to the guide", () => {
    const html = adminQuestionsPage([colourQuestion], TEST_SESSION);
    expect(html).toContain('class="active" href="/admin/questions"');
    expect(html).toContain(
      '<form action="/admin/questions" autocomplete="off" method="POST" id="new-question">',
    );
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
      TEST_SESSION,
    );
    // First question: down button, but no up button.
    expect(html).toContain("/admin/questions/1/move-down");
    expect(html).not.toContain("/admin/questions/1/move-up");
    // Last question: up button, but no down button.
    expect(html).toContain("/admin/questions/2/move-up");
    expect(html).not.toContain("/admin/questions/2/move-down");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionsPage([], TEST_SESSION, "Something went wrong");
    expect(html).toContain("Something went wrong");
  });

  test("keeps the list readable without write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionsPage([colourQuestion], TEST_SESSION);
    expect(html).toContain("Favourite colour?");
    expect(html).toContain('href="/admin/questions/1"');
    expect(html).not.toContain('id="new-question"');
    expect(html).not.toContain("/admin/questions/1/move-");
  });
});

describe("adminQuestionPage", () => {
  const question = tShirtQuestion;

  test("renders question text and edit form", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('action="/admin/questions/1/edit"');
    expect(html).toContain('class="active" href="/admin/questions"');
    // The choice-type selector offers radio vs select, with the question's
    // current type (radio) pre-selected.
    expect(html).toContain(
      '<select name="display_type"><option selected value="radio">Radio buttons</option><option value="select">Select box</option></select>',
    );
  });

  test("renders answer list linking to each answer's edit page", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("Small");
    expect(html).toContain("Large");
    expect(html).toContain('href="/admin/questions/1/answers/10/edit"');
    expect(html).toContain('href="/admin/questions/1/answers/11/edit"');
    expect(html).toContain(
      '<form action="/admin/questions/1/answers" autocomplete="off" method="POST" id="add-answer">',
    );
  });

  test("no longer links to answer deletion from the question page", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).not.toContain("/admin/questions/1/answers/10/delete");
  });

  test("renders delete question link", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain('href="/admin/questions/1/delete"');
  });

  test("renders error message when provided", () => {
    const html = adminQuestionPage(question, TEST_SESSION, "Error!");
    expect(html).toContain("Error!");
  });

  test("renders empty answers state", () => {
    const html = adminQuestionPage(
      testQuestion({ id: 1, text: "Q?" }),
      TEST_SESSION,
    );
    expect(html).toContain("No answers yet");
  });

  test("locks the type on a free-text question's edit form", () => {
    const html = adminQuestionPage(
      testQuestion({
        display_type: "free_text",
        id: 1,
        text: "Notes?",
      }),
      TEST_SESSION,
    );
    // No selector — a hidden field keeps it free-text and the choice options
    // are not offered.
    expect(html).toContain(
      '<input name="display_type" type="hidden" value="free_text"',
    );
    expect(html).not.toContain("Radio buttons");
  });

  test("hides answer management for a free-text question", () => {
    const html = adminQuestionPage(
      testQuestion({
        display_type: "free_text",
        id: 1,
        text: "Notes?",
      }),
      TEST_SESSION,
    );
    // No add-answer form or answer heading — just an explanatory note that also
    // tells the operator a free-text question can't drive a price, and why.
    expect(html).not.toContain("/admin/questions/1/answers");
    expect(html).toContain("they have no answer options");
    expect(html).toContain("can't change the price");
    expect(html).toContain("a price modifier attaches to a chosen answer");
  });

  test("renders answers in a table with their selection totals", () => {
    const counts = new Map([
      [10, 5],
      [11, 3],
    ]);
    const html = adminQuestionPage(question, TEST_SESSION, undefined, counts);
    expect(html).toContain("<table");
    expect(html).toContain('<td class="col-quantity">5</td>');
    expect(html).toContain('<td class="col-quantity">3</td>');
  });

  test("shows zero selections for answers with no stored total", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
      undefined,
      new Map(),
    );
    expect(html).toContain('<td class="col-quantity">0</td>');
  });

  test("renders move-up and move-down buttons", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("/answers/10/move-down");
    expect(html).not.toContain("/answers/10/move-up");
    expect(html).toContain("/answers/11/move-up");
    expect(html).not.toContain("/answers/11/move-down");
    // The answers table carries the reorder Order column header when writable.
    expect(html).toContain('<th class="col-reorder">Order</th>');
  });

  test("renders both move buttons for middle answer", () => {
    const q = testQuestion({
      answers: [
        testAnswer({ id: 10, sort_order: 0, text: "A" }),
        testAnswer({ id: 11, sort_order: 1, text: "B" }),
        testAnswer({ id: 12, sort_order: 2, text: "C" }),
      ],
      id: 1,
      text: "Q?",
    });
    const html = adminQuestionPage(q, TEST_SESSION);
    expect(html).toContain("/answers/11/move-up");
    expect(html).toContain("/answers/11/move-down");
  });

  test("keeps question details readable without write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionPage(
      { ...question, assign_all: false },
      TEST_SESSION,
      undefined,
      new Map([[10, 5]]),
      TEST_LISTINGS,
      new Set([1]),
    );
    expect(html).toContain("T-shirt size?");
    expect(html).toContain("<p>Spring Gig</p>");
    expect(html).not.toContain("<p>Summer Gig</p>");
    expect(html).not.toContain('action="/admin/questions/1/listings"');
    expect(html).not.toContain('action="/admin/questions/1/edit"');
    expect(html).not.toContain("/admin/questions/1/answers/10/edit");
    expect(html).not.toContain("/admin/questions/1/delete");
    expect(html).not.toContain("/answers/10/move-");
    // No reorder Order column on the answers table in read-only mode.
    expect(html).not.toContain('<th class="col-reorder">');
  });

  test("joins multiple assigned listing names with a comma in read-only mode", () => {
    // Read-only shows the assigned listings as plain text; two assigned
    // listings must render comma-separated, not run together into one word.
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionPage(
      { ...question, assign_all: false },
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set([1, 2]),
    );
    expect(html).toContain("<p>Spring Gig, Summer Gig</p>");
  });

  test("renders empty state when no listings exist", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("Assign to Listings");
    expect(html).toContain("No listings yet");
  });

  test("renders an listing checkbox for each listing", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    expect(html).toContain(
      '<form action="/admin/questions/1/listings" autocomplete="off" method="POST" id="question-listings">',
    );
    expect(html).toContain("<strong>Linked listings (0):</strong>");
    expect(html).toContain('name="listing_ids"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain("Spring Gig");
    expect(html).toContain("Summer Gig");
  });

  test("renders the assign-to-all toggle before the listing checkboxes", () => {
    const html = adminQuestionPage(
      { ...question, assign_all: true },
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    const toggle = html.indexOf('checked name="assign_all" type="checkbox"');
    const firstListing = html.indexOf('name="listing_ids"');
    expect(toggle).toBeGreaterThan(-1);
    expect(firstListing).toBeGreaterThan(toggle);
    expect(html).toContain("Assign to all listings");
  });

  test("shows an '(all)' heading, not a stored-id count, when assign-all is set", () => {
    // assign_all applies to every listing even with no individually-ticked ids,
    // so the count must not read "(0)" next to a checked "Assign to all" toggle.
    const html = adminQuestionPage(
      { ...question, assign_all: true },
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set(),
    );
    expect(html).toContain("<strong>Linked listings (all):</strong>");
    expect(html).not.toContain("Linked listings (0):");
  });

  test("sorts a deactivated listing last and renders it muted", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
      undefined,
      undefined,
      [
        testListingWithCount({ active: false, id: 1, name: "Retired Gig" }),
        testListingWithCount({ active: true, id: 2, name: "Live Gig" }),
      ],
    );
    const live = html.indexOf('value="2"');
    const retired = html.indexOf(
      '<label class="muted"><input name="listing_ids" type="checkbox" value="1"',
    );
    expect(live).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(live);
  });

  test("checks listings the question is assigned to", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set([1]),
    );
    expect(html).toContain(
      'checked name="listing_ids" type="checkbox" value="1"',
    );
    expect(html).not.toContain(
      'checked name="listing_ids" type="checkbox" value="2"',
    );
  });
});

describe("adminQuestionDeletePage", () => {
  const question = testQuestion({
    answers: [testAnswer({ id: 10, sort_order: 0, text: "Small" })],
    id: 1,
    text: "T-shirt size?",
  });

  test("renders confirmation form with question text", () => {
    const html = adminQuestionDeletePage(question, TEST_SESSION);
    expect(html).toContain("Delete Question");
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/delete"');
    expect(html).toContain('class="active" href="/admin/questions"');
  });

  test("warns about cascading deletes", () => {
    const html = adminQuestionDeletePage(question, TEST_SESSION);
    expect(html).toContain("all its answers");
    expect(html).toContain("attendee responses");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionDeletePage(
      question,
      TEST_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});

describe("adminAnswerEditPage", () => {
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
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
      TEST_SESSION,
      "Invalid modifier",
      aligned,
      modifiers,
      null,
    );
    expect(html).toContain("Invalid modifier");
  });
});

describe("adminAnswerRecalculatePage", () => {
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
      TEST_SESSION,
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
        TEST_SESSION,
        "Choose at least one total to recalculate",
      ),
    ).toContain("Choose at least one total to recalculate");
    expect(
      adminAnswerRecalculatePage(
        question,
        answer,
        snapshot,
        TEST_SESSION,
        undefined,
        "Selection total recalculated",
      ),
    ).toContain("Selection total recalculated");
  });
});

describe("adminAnswerDeletePage", () => {
  const question = tShirtQuestion;
  const answer = question.answers[0]!;

  test("renders confirmation form with answer text", () => {
    const html = adminAnswerDeletePage(question, answer, TEST_SESSION);
    expect(html).toContain("Delete Answer");
    expect(html).toContain("Small");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/answers/10/delete"');
  });

  test("shows question context", () => {
    const html = adminAnswerDeletePage(question, answer, TEST_SESSION);
    expect(html).toContain("T-shirt size?");
  });

  test("renders error message when provided", () => {
    const html = adminAnswerDeletePage(
      question,
      answer,
      TEST_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});

describe("adminListingQuestionsPage", () => {
  test("shows empty state when no questions exist", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const html = String(
      ListingQuestionsPanel({
        allQuestions: [],
        assignedIds: new Set(),
        listing,
      }),
    );
    // The empty-state prompt keeps a space before the create link.
    expect(html).toContain(
      'No questions created yet. <a href="/admin/questions">Create questions</a> first.',
    );
  });

  test("shows singular option count for question with one answer", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [testAnswer({ id: 10, text: "Yes" })],
        id: 1,
        text: "Yes or no?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    expect(html).toContain(
      '<input name="question_ids" type="checkbox" value="1">',
    );
    // A single space sits before the "(1 option…)" summary inside the label.
    expect(html).toContain("<small> (1 option: Yes)</small>");
    expect(html).not.toContain("1 options");
  });

  test("shows Manage Questions link below form", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [
          testAnswer({ id: 10, sort_order: 0, text: "A" }),
          testAnswer({ id: 11, sort_order: 1, text: "B" }),
        ],
        id: 1,
        text: "Q?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Manage Questions");
  });

  test("lists option names in parentheses", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [
          testAnswer({ id: 10, sort_order: 0, text: "S" }),
          testAnswer({ id: 11, sort_order: 1, text: "M" }),
          testAnswer({ id: 12, sort_order: 2, text: "L" }),
        ],
        id: 1,
        text: "Size?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    expect(html).toContain("3 options: S, M, L)");
  });
});

describe("adminListingPage with questionData", () => {
  test("renders answer summary rows in details table", () => {
    const listing = testListingWithCount({ id: 1, name: "E" });
    const html = String(
      ListingOverviewPanel({
        allowedDomain: "example.com",
        listing,
        noteNames: new Map(),
        questionData: singleAnswerSizeQuestionData(),
        stats: overviewStatsFromAttendees(listing, []),
      }),
    );
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("S (0)");
  });
});

describe("questionTextFlat", () => {
  test("returns plain text unchanged", () => {
    expect(questionTextFlat("What is your T-shirt size?")).toBe(
      "What is your T-shirt size?",
    );
  });

  test("replaces a single newline with ' / '", () => {
    expect(questionTextFlat("Line 1\nLine 2")).toBe("Line 1 / Line 2");
  });

  test("replaces multiple newlines with ' / '", () => {
    expect(questionTextFlat("A\nB\nC")).toBe("A / B / C");
  });

  test("replaces Windows-style CRLF newlines", () => {
    expect(questionTextFlat("A\r\nB")).toBe("A / B");
  });

  test("preserves markdown syntax (does not render it)", () => {
    const result = questionTextFlat("**bold** and [link](https://x.com)");
    expect(result).toBe("**bold** and [link](https://x.com)");
  });

  test("flattens multi-line markdown to a single line", () => {
    const result = questionTextFlat("# Heading\n\nSome **bold** text");
    expect(result).not.toContain("\n");
    expect(result).toBe("# Heading /  / Some **bold** text");
  });
});
