import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import {
  buildAnswerMaps,
  formatAddressInline,
  formatInstructionsInline,
  getAnswerDisplay,
  hiddenAttendeeColumnKeys,
  sortAttendeeRows,
} from "#templates/attendee-table/values.ts";
import { testAttendee } from "#test-utils/factories.ts";
import {
  attendeeTableSuite,
  makeOpts,
  makeRow,
  namedListingRow,
} from "./shared.ts";

attendeeTableSuite(() => {
  describe("sortAttendeeRows", () => {
    test("sorts by listing date with missing dates last", () => {
      const rows = [
        namedListingRow("A", testAttendee({ date: "2026-03-01", id: 2 })),
        namedListingRow("A", testAttendee({ date: null, id: 1 })),
        namedListingRow("A", testAttendee({ date: "2026-01-15", id: 3 })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        3, 2, 1,
      ]);
    });

    test("sorts by first listing name when dates match", () => {
      const rows = [
        namedListingRow("Zebra", testAttendee({ date: "2026-03-01", id: 1 })),
        namedListingRow("Alpha", testAttendee({ date: "2026-03-01", id: 2 })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts by attendee name when date and listing match", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 1, name: "Zara" })),
        namedListingRow("Gala", testAttendee({ id: 2, name: "Alice" })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts by id when all other fields match", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 5, name: "Sam" })),
        namedListingRow("Gala", testAttendee({ id: 2, name: "Sam" })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 5,
      ]);
    });

    test("applies the complete multi-key order", () => {
      const rows = [
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-02-01", id: 1, name: "Bob" }),
        ),
        namedListingRow(
          "Gala",
          testAttendee({ date: null, id: 2, name: "Alice" }),
        ),
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-01-15", id: 3, name: "Alice" }),
        ),
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-02-01", id: 4, name: "Alice" }),
        ),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        3, 4, 1, 2,
      ]);
    });

    test("sorts a listing-less row before a named listing", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 1 })),
        makeRow({ attendee: testAttendee({ id: 2 }), listings: [] }),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts listing-less rows by attendee name", () => {
      const rows = [
        makeRow({
          attendee: testAttendee({ id: 1, name: "Zara" }),
          listings: [],
        }),
        makeRow({
          attendee: testAttendee({ id: 2, name: "Alice" }),
          listings: [],
        }),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("preserves input order when all sort keys match", () => {
      const first = namedListingRow(
        "Gala",
        testAttendee({ email: "first@example.com", id: 1, name: "Sam" }),
      );
      const second = namedListingRow(
        "Gala",
        testAttendee({ email: "second@example.com", id: 1, name: "Sam" }),
      );

      expect(
        sortAttendeeRows([first, second]).map((row) => row.attendee.email),
      ).toEqual(["first@example.com", "second@example.com"]);
    });

    test("preserves input order for a longer run of matching keys", () => {
      const rows = ["a@x", "b@x", "c@x"].map((email) =>
        namedListingRow("Gala", testAttendee({ email, id: 1, name: "Sam" })),
      );
      expect(sortAttendeeRows(rows).map((row) => row.attendee.email)).toEqual([
        "a@x",
        "b@x",
        "c@x",
      ]);
    });

    test("does not mutate the input", () => {
      const rows = [
        namedListingRow("B", testAttendee({ id: 2 })),
        namedListingRow("A", testAttendee({ id: 1 })),
      ];
      sortAttendeeRows(rows);
      expect(rows.map((row) => row.attendee.id)).toEqual([2, 1]);
    });
  });

  describe("formatInstructionsInline", () => {
    test("returns an empty string for empty input", () => {
      expect(formatInstructionsInline("")).toBe("");
    });

    test("puts every line on one line", () => {
      expect(formatInstructionsInline("No nuts\nUses a wheelchair")).toBe(
        "No nuts Uses a wheelchair",
      );
    });

    test("collapses blank lines and trims the ends", () => {
      expect(formatInstructionsInline("  No nuts\n\nLate arrival  ")).toBe(
        "No nuts Late arrival",
      );
    });
  });

  describe("formatAddressInline", () => {
    test("returns an empty string for empty input", () => {
      expect(formatAddressInline("")).toBe("");
    });

    test("joins lines with commas", () => {
      expect(formatAddressInline("123 Main St\nApt 4\nNew York")).toBe(
        "123 Main St, Apt 4, New York",
      );
    });

    test("does not duplicate an existing trailing comma", () => {
      expect(formatAddressInline("123 Main St,\nNew York")).toBe(
        "123 Main St, New York",
      );
    });

    test("trims each line", () => {
      expect(formatAddressInline("  123 Main St  \n  New York  ")).toBe(
        "123 Main St, New York",
      );
    });

    test("removes blank lines", () => {
      expect(formatAddressInline("123 Main St\n\nNew York")).toBe(
        "123 Main St, New York",
      );
    });
  });
});

const questions: QuestionWithAnswers[] = [
  {
    answers: [
      { active: true, id: 11, question_id: 1, sort_order: 0, text: "Vegan" },
      { active: true, id: 12, question_id: 1, sort_order: 1, text: "None" },
    ],
    display_type: "radio",
    id: 1,
    text: "Dietary needs",
  },
  { answers: [], display_type: "free_text", id: 2, text: "Notes" },
];

describe("buildAnswerMaps", () => {
  test("indexes each option's text and its question's text by option id", () => {
    const maps = buildAnswerMaps(questions);
    expect(maps.answerTextMap.get(11)).toBe("Vegan");
    expect(maps.answerTextMap.get(12)).toBe("None");
    expect(maps.answerQuestionMap.get(11)).toBe("Dietary needs");
  });
});

describe("getAnswerDisplay", () => {
  test("joins chosen options and free text in both views", () => {
    const questionData = {
      attendeeAnswerMap: new Map([[7, [11, 12]]]),
      questions,
      textAnswerMap: new Map([[7, new Map([[2, "Brings a dog"]])]]),
    };
    const maps = buildAnswerMaps(questions);
    const display = getAnswerDisplay(
      7,
      questionData,
      maps.answerTextMap,
      maps.answerQuestionMap,
    );
    expect(display.short).toBe("Vegan, None, Brings a dog");
    expect(display.tooltip).toBe(
      "Dietary needs: Vegan, Dietary needs: None, Notes: Brings a dog",
    );
  });

  test("leaves an option without a known question out of the tooltip", () => {
    const questionData = {
      attendeeAnswerMap: new Map([[7, [99]]]),
      questions,
    };
    const display = getAnswerDisplay(
      7,
      questionData,
      new Map([[99, "Vegan"]]),
      new Map<number, string>(),
    );
    expect(display.short).toBe("Vegan");
    expect(display.tooltip).toBe("");
  });
});

describe("hiddenAttendeeColumnKeys", () => {
  const cols = (overrides: Parameters<typeof makeOpts>[0] = {}): string[] => [
    ...hiddenAttendeeColumnKeys([makeRow()], makeOpts(overrides)),
  ];

  test("hides the contact columns no row fills", () => {
    // The shared row's attendee holds an email but nothing else, and no
    // question data or listing/date columns were asked for.
    expect(cols().sort()).toEqual([
      "address",
      "answers",
      "date",
      "listings",
      "phone",
      "special_instructions",
    ]);
  });

  test("keeps a contact column any row fills", () => {
    const filled = makeRow({
      attendee: testAttendee({
        address: "1 Road",
        phone: "07",
        special_instructions: "None",
      }),
    });
    expect(
      hiddenAttendeeColumnKeys([filled], makeOpts({ rows: [filled] })),
    ).toEqual(new Set(["answers", "date", "listings"]));
  });

  test("hides status only when check-in is turned off", () => {
    expect(cols()).not.toContain("status");
    expect(cols({ showCheckin: false })).toContain("status");
    expect(cols({ showCheckin: true })).not.toContain("status");
  });

  test("hides the listings and date columns the caller turns off", () => {
    expect(cols()).toContain("listings");
    expect(cols({ showListing: true })).not.toContain("listings");
    expect(cols()).toContain("date");
    expect(cols({ showDate: true })).not.toContain("date");
  });

  test("hides the answers column until question data with questions arrives", () => {
    const withQuestions = (questionList: QuestionWithAnswers[]) => ({
      attendeeAnswerMap: new Map<number, number[]>(),
      questions: questionList,
    });
    expect(cols()).toContain("answers");
    expect(cols({ questionData: withQuestions([]) })).toContain("answers");
    expect(cols({ questionData: withQuestions(questions) })).not.toContain(
      "answers",
    );
  });
});
