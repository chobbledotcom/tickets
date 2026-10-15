// jscpd:ignore-start -- fixtures mirror the sibling editor tests

import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { ParsedAttendeeForm } from "#routes/admin/attendee-form-model.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import {
  AttendeeFormPanel,
  AttendeesPage,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { attendeeFormLine } from "#test-utils/attendee-form-factories.ts";
import { formData } from "./fixtures.ts";

// jscpd:ignore-end

const parsed = (
  overrides: Partial<ParsedAttendeeForm> = {},
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: [attendeeFormLine()],
  name: "Test",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
  ...overrides,
});

const statuses = (): AttendeeStatus[] => [
  {
    id: 4,
    // The public default is not the paid default, so a mutant that resolves
    // the selection with the wrong flag cannot pass.
    is_paid_default: false,
    is_public_default: true,
    is_reservation: false,
    name: "Confirmed",
    reservation_amount: "0",
    sort_order: 1,
  },
  {
    id: 9,
    is_paid_default: true,
    is_public_default: false,
    is_reservation: false,
    name: "Cancelled",
    reservation_amount: "0",
    sort_order: 2,
  },
];

const question = (): QuestionWithAnswers => ({
  answers: [
    { active: true, id: 61, question_id: 6, sort_order: 1, text: "Vegan" },
    { active: true, id: 62, question_id: 6, sort_order: 2, text: "Standard" },
  ],
  display_type: "radio",
  id: 6,
  text: "Meal preference",
});

const data = (
  overrides: Partial<AttendeeFormTemplateData> = {},
): AttendeeFormTemplateData =>
  formData(parsed(), {
    statuses: statuses(),
    ...overrides,
  });

const render = (overrides: Partial<AttendeeFormTemplateData> = {}): string =>
  String(AttendeeFormPanel({ data: data(overrides) }));

describe("attendee form panel", () => {
  beforeAll(setupAdminPageTest);

  test("renders the create form with its action, title, and section legends", () => {
    const html = render();
    assertStringIncludes(html, 'id="attendee-form"');
    assertStringIncludes(html, '<form action="/admin/attendees/new"');
    assertStringIncludes(html, "<h1>Add new attendee</h1>");
    assertStringIncludes(html, "<legend>Attendee Details</legend>");
    assertStringIncludes(html, "<legend>Listing Registrations</legend>");
    assert(
      !html.includes("<legend>Dates</legend>"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("<legend>Custom Questions</legend>"),
      "the value should not contain the searched item",
    );
  });

  test("pins the contact inputs with their ids, limits, and types", () => {
    const html = render({
      parsed: parsed({
        address: "1 Road",
        email: "ada@example.com",
        name: "Ada Byron",
        phone: "07946 123456",
        special_instructions: "Leave at the desk",
      }),
    });
    assertStringIncludes(
      html,
      '<label for="name">Name<input autocomplete="off" autofocus id="name" maxlength="250" name="name" required type="text" value="Ada Byron"></label>',
    );
    assertStringIncludes(
      html,
      '<label for="email">Email<input autocomplete="off" id="email" maxlength="250" name="email" type="email" value="ada@example.com"></label>',
    );
    assertStringIncludes(
      html,
      '<label for="phone">Phone<input autocomplete="off" id="phone" maxlength="32" name="phone" pattern="[+\\d][\\d\\s\\-\\(\\)]{5,}" title="Phone number (digits, spaces, hyphens, parentheses, optional leading +)" type="text" value="07946 123456"></label>',
    );
    assertStringIncludes(
      html,
      '<label for="special_instructions">Special Instructions<textarea autocomplete="off" id="special_instructions" maxlength="250" name="special_instructions" rows="3">',
    );
    assertStringIncludes(html, "1 Road</textarea>");
    assertStringIncludes(html, "Leave at the desk</textarea>");
  });

  test("keeps an empty contact field from picking up placeholder text", () => {
    const html = render();
    assertStringIncludes(
      html,
      'id="email" maxlength="250" name="email" type="email" value="">',
    );
    assertStringIncludes(
      html,
      'id="phone" maxlength="32" name="phone" pattern="',
    );
    assert(
      !html.includes("mutated"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      'id="address" maxlength="250" name="address" rows="3">',
    );
  });

  test("gives the name field autofocus only when the form has no error", () => {
    const clean = render();
    assertStringIncludes(
      clean,
      '<input autocomplete="off" autofocus id="name" maxlength="250" name="name" required type="text" value="Test">',
    );

    // One error at a time: every error slot must suppress the autofocus on its
    // own, or a mutant that merges two slots with `and` would survive.
    const singleErrors = [
      { attendeeError: "The attendee no longer exists." },
      { dateError: "Start date is in the past." },
      { formError: "Some answers were missing." },
      { saveError: "The server refused the save." },
      {
        parsed: parsed({
          lines: [
            attendeeFormLine({ error: "Not enough places left on 5 June." }),
          ],
        }),
      },
    ] as Partial<AttendeeFormTemplateData>[];
    for (const single of singleErrors) {
      const withError = render(single);
      assertStringIncludes(
        withError,
        'id="name" maxlength="250" name="name" required',
      );
      assert(
        !withError.includes('autofocus id="name"'),
        "the value should not contain the searched item",
      );
    }
  });

  test("labels the contact fields, the date fields, and their hints", () => {
    const html = render({ hasDailyListings: true });
    assertStringIncludes(html, "<legend>Attendee Details</legend>");
    assertStringIncludes(html, "<legend>Dates</legend>");
    assertStringIncludes(html, "Start date");
    assertStringIncludes(html, "Length");
    assertStringIncludes(html, "Phone");
    assertStringIncludes(html, "Special Instructions");
    assertStringIncludes(
      html,
      "Optional — the date only affects daily listings. A start date is required once you book a daily listing below.",
    );
  });

  test("renders the status select with the public default selected", () => {
    const html = render({ statuses: statuses() });
    assertStringIncludes(html, "<legend>Attendee Details</legend>");
    assertStringIncludes(html, '<option selected value="4">Confirmed</option>');
    assertStringIncludes(html, '<option value="9">Cancelled</option>');
  });

  test("renders a hidden status input when one status or none is known", () => {
    const html = render({
      parsed: parsed({ statusId: 4 }),
      statuses: [],
    });
    assertStringIncludes(
      html,
      '<input name="status_id" type="hidden" value="4">',
    );

    const oneStatus = render({
      parsed: parsed({ statusId: 4 }),
      statuses: [statuses()[0]!],
    });
    assertStringIncludes(
      oneStatus,
      '<input name="status_id" type="hidden" value="4">',
    );
    assert(
      !oneStatus.includes('id="status_id"'),
      "the value should not contain the searched item",
    );
  });

  test("shows the balance notice with its tone", () => {
    const html = render({
      balanceNotice: {
        message: "This attendee is in a paid status but still owes £5.00.",
        tone: "warning",
      },
    });
    assertStringIncludes(
      html,
      '<output class="warning">This attendee is in a paid status but still owes £5.00.</output>',
    );
  });

  test("hides the availability notice once a start date is known", () => {
    const bare = render({ hasDailyListings: true });
    assertStringIncludes(
      bare,
      "Availability is inaccurate until dates have been saved.",
    );
    assert(
      !bare.includes('<output class="warning" data-availability-notice hidden'),
      "the value should not contain the searched item",
    );

    const dated = render({
      hasDailyListings: true,
      parsed: parsed({ startDate: "2026-06-05" }),
    });
    assertStringIncludes(
      dated,
      '<output class="warning" data-availability-notice hidden>',
    );
  });

  test("shows the dates section only for daily listings, with its hint", () => {
    const html = render({ hasDailyListings: true });
    assertStringIncludes(html, "<legend>Dates</legend>");
    assertStringIncludes(html, 'id="start_date"');
    assertStringIncludes(
      html,
      '<input id="start_date" name="start_date" type="date" value="">',
    );

    const dated = render({
      hasDailyListings: true,
      parsed: parsed({ startDate: "2026-06-05" }),
    });
    assertStringIncludes(
      dated,
      '<input id="start_date" name="start_date" type="date" value="2026-06-05">',
    );
  });

  test("labels day-count options with the resulting end date when dated", () => {
    const html = render({
      hasDailyListings: true,
      parsed: parsed({ startDate: "2026-06-05" }),
    });
    assertStringIncludes(
      html,
      '<option selected value="1">1 day: Friday 5 June 2026</option>',
    );
    assertStringIncludes(
      html,
      '<option value="2">2 days: Saturday 6 June 2026</option>',
    );
    assertStringIncludes(
      html,
      '<option value="90">90 days: Wednesday 2 September 2026</option>',
    );
  });

  test("labels day-count options as bare day counts without a start date", () => {
    const html = render({ hasDailyListings: true });
    assertStringIncludes(html, '<option selected value="1">1 day</option>');
    assertStringIncludes(html, '<option value="2">2 days</option>');
    assertStringIncludes(html, '<option value="90">90 days</option>');
    // The count is never 0: the select starts at one booked day.
    assert(
      !html.includes('<option value="0">'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      '<p class="small">Optional — the date only affects daily listings.',
    );
  });

  test("selects the parsed day count", () => {
    const html = render({
      hasDailyListings: true,
      parsed: parsed({ dayCount: 2 }),
    });
    assertStringIncludes(html, '<option selected value="2">2 days</option>');
  });

  test("warns when daily timings disagree", () => {
    const html = render({ hasMixedTimings: true });
    assertStringIncludes(
      html,
      '<output class="warning">This attendee\'s existing daily listings have different start dates or lengths. Saving will put them all on the one date range above.</output>',
    );
  });

  test("renders the custom questions section with its legend", () => {
    const html = render({
      questions: [question()],
      selectedAnswerIds: [61],
    });
    assertStringIncludes(html, "<legend>Custom Questions</legend>");
    assertStringIncludes(html, "<legend>Meal preference</legend>");
    assertStringIncludes(
      html,
      '<input checked name="question_6" type="radio" value="61"> Vegan',
    );
    assertStringIncludes(
      html,
      '<input name="question_6" type="radio" value="62"> Standard',
    );
  });

  test("lists the top warnings under the double-check heading", () => {
    const html = render({
      topWarnings: ["Daily listings have no start date."],
    });
    assertStringIncludes(
      html,
      '<output class="warning" role="alert"><strong>Please double-check:</strong><ul><li>Daily listings have no start date.</li></ul></output>',
    );
  });

  test("renders each error as a focusable alert", () => {
    const html = render({
      attendeeError: "The attendee no longer exists.",
      formError: "Some answers were missing.",
      saveError: "The server refused the save.",
    });
    assertStringIncludes(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">The server refused the save.</div>',
    );
    assertStringIncludes(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">Some answers were missing.</div>',
    );
    assertStringIncludes(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">The attendee no longer exists.</div>',
    );
  });

  test("wraps a date error in its own alert inside the dates section", () => {
    const html = render({
      dateError: "Start date is in the past.",
      hasDailyListings: true,
    });
    assertStringIncludes(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">Start date is in the past.</div>',
    );
  });

  test("renders no error alerts when the form is clean", () => {
    assert(
      !render({ hasDailyListings: true }).includes(
        '<div autofocus class="error" role="alert" tabindex="-1"></div>',
      ),
      "the value should not contain the searched item",
    );
  });

  test("carries the return URL as a hidden field", () => {
    const html = render({ returnUrl: "/admin/attendees" });
    assertStringIncludes(
      html,
      '<input name="return_url" type="hidden" value="/admin/attendees">',
    );
  });

  test("posts an edit to the attendee's own route and relabels the button", () => {
    const html = render({
      attendee: { id: 42 } as AttendeeFormTemplateData["attendee"],
      mode: "edit",
      statuses: statuses(),
    });
    assertStringIncludes(html, '<form action="/admin/attendees/42"');
    assert(
      !html.includes("<h1>Add new attendee</h1>"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "Save Attendee");
    assert(
      !html.includes("Create Attendee"),
      "the value should not contain the searched item",
    );
  });
});

describe("attendee form page shells", () => {
  beforeAll(setupAdminPageTest);

  test("the attendees page shell defaults its active section to the list", () => {
    const html = AttendeesPage({
      children: Raw({ html: "<p>Body</p>" }),
      session: OWNER_SESSION,
      title: "Attendees",
    });
    assertStringIncludes(html, '<a class="active" href="/admin/attendees">');
    assertStringIncludes(html, "<h1>Attendees</h1>");
  });

  test("the create page carries the new-attendee section and tab title", () => {
    const html = attendeeFormPage(data(), OWNER_SESSION);
    assertStringIncludes(
      html,
      '<a class="active" href="/admin/attendees/new">',
    );
    assertStringIncludes(html, "<title>Add new attendee</title>");
    assertStringIncludes(html, "<h1>Add new attendee</h1>");
  });
});
