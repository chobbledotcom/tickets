import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { generateAttendeesCsv } from "#routes/admin/attendees-csv.ts";
import { testAttendee } from "#test-utils/factories.ts";
import type { Attendee } from "#types";

/** Build a question with answers that each have a distinct numeric id. */
const question = (
  id: number,
  text: string,
  answers: { id: number; text: string }[],
): QuestionWithAnswers => ({
  answerLevel: "booking",
  answers: answers.map((a, i) => ({
    active: true,
    id: a.id,
    questionId: id,
    sortOrder: i,
    text: a.text,
  })),
  assignAll: false,
  displayType: "radio",
  id,
  text,
});

const SIZE_Q = question(1, "T-shirt Size", [
  { id: 10, text: "Small" },
  { id: 11, text: "Large" },
]);

const DIET_Q = question(2, "Dietary Requirements", [
  { id: 20, text: "None" },
  { id: 21, text: "Vegetarian" },
]);

const NOTES_Q: QuestionWithAnswers = {
  answerLevel: "booking",
  answers: [],
  assignAll: false,
  displayType: "free_text",
  id: 3,
  text: "Notes",
};

const csvWithQuestions = (
  attendees: Parameters<typeof generateAttendeesCsv>[0],
  questions: QuestionWithAnswers[],
  attendeeAnswerMap: Map<number, number[]>,
): string[] =>
  generateAttendeesCsv(attendees, false, undefined, {
    attendeeAnswerMap,
    questions,
  }).split("\n");

/** CSV lines for one attendee and their free-text answer to "Notes". */
const freeTextCsv = (answer: string): string[] =>
  generateAttendeesCsv([testAttendee({ id: 1 })], false, undefined, {
    attendeeAnswerMap: new Map(),
    questions: [NOTES_Q],
    textAnswerMap: new Map([[1, new Map([[3, answer]])]]),
  }).split("\n");

/** A free-text question that asks for each line or each ticket. */
const lineQuestion = (
  id: number,
  text: string,
  answerLevel: "listing" | "quantity",
): QuestionWithAnswers => ({ ...NOTES_Q, answerLevel, id, text });

const PUPIL_Q = lineQuestion(4, "Pupil name", "quantity");
const GLOW_Q = lineQuestion(5, "Glow name", "listing");

/** One stored answer for a ticket of a line of quantity `quantity`. */
const ticketAnswer = (
  questionId: number,
  text: string,
  {
    packageGroupId = 0,
    parentListingId = 0,
    quantity = 1,
    startAt = null as string | null,
    unit = 0,
  } = {},
) => ({
  listingId: 1,
  packageGroupId,
  parentListingId,
  quantity,
  questionId,
  startAt,
  text,
  unit,
});

/** CSV lines for Alice and Bob with these line answers. */
const lineAnswerCsv = (
  questions: QuestionWithAnswers[],
  answers: [number, ReturnType<typeof ticketAnswer>[]][],
): string[] =>
  generateAttendeesCsv(
    [
      testAttendee({ id: 1, name: "Alice" }),
      testAttendee({ id: 2, name: "Bob" }),
    ],
    false,
    undefined,
    {
      attendeeAnswerMap: new Map(),
      lineAnswerMap: new Map(answers),
      questions,
    },
  ).split("\n");

describe("CSV with custom questions", () => {
  test("appends question text columns after the ticket URL column", () => {
    const [header] = csvWithQuestions(
      [testAttendee()],
      [SIZE_Q, DIET_Q],
      new Map(),
    );
    expect(header!.endsWith(",T-shirt Size,Dietary Requirements")).toBe(true);
  });

  test("renders the selected answer text in the column for its question", () => {
    const alice = testAttendee({ id: 1, name: "Alice" });
    const bob = testAttendee({ id: 2, name: "Bob" });
    const [, aliceRow, bobRow] = csvWithQuestions(
      [alice, bob],
      [SIZE_Q, DIET_Q],
      new Map([
        [1, [10, 21]], // Alice: Small, Vegetarian
        [2, [11, 20]], // Bob: Large, None
      ]),
    );
    // Question columns are the last two: ...,<size>,<diet>
    expect(aliceRow!.endsWith(",Small,Vegetarian")).toBe(true);
    expect(bobRow!.endsWith(",Large,None")).toBe(true);
  });

  test("renders free-text answers from the text-answer map", () => {
    const [header, row] = freeTextCsv("Coeliac, no nuts");
    expect(header!.endsWith(",Notes")).toBe(true);
    expect(row!.endsWith(',"Coeliac, no nuts"')).toBe(true);
  });

  test("leaves a free-text column blank when the attendee gave no text answer", () => {
    const [, row] = generateAttendeesCsv(
      [testAttendee({ id: 1 })],
      false,
      undefined,
      {
        attendeeAnswerMap: new Map(),
        questions: [NOTES_Q],
        textAnswerMap: new Map(),
      },
    ).split("\n");
    expect(row!.endsWith(",")).toBe(true);
  });

  test("stops a free-text answer that starts like a spreadsheet formula", () => {
    const [, row] = freeTextCsv("=2+5*9");
    expect(row!.endsWith(',"\t=2+5*9"')).toBe(true);
  });

  test("leaves the question column blank when the attendee did not answer it", () => {
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [SIZE_Q, DIET_Q],
      new Map([[1, [10]]]), // answered size only
    );
    // Expect the two trailing question cells to be "Small" and "" (blank)
    expect(row!.endsWith(",Small,")).toBe(true);
  });

  test("leaves all question columns blank when the attendee map has no entry", () => {
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [SIZE_Q, DIET_Q],
      new Map(),
    );
    expect(row!.endsWith(",,")).toBe(true);
  });

  test("escapes commas in question text", () => {
    const commaQuestion = question(3, "Name, as printed on ticket", [
      { id: 30, text: "Y" },
    ]);
    const [header] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [commaQuestion],
      new Map([[1, [30]]]),
    );
    assertStringIncludes(header ?? "", '"Name, as printed on ticket"');
  });

  test("escapes commas in answer text", () => {
    const q = question(4, "Allergies", [
      { id: 40, text: "Nuts, dairy" },
      { id: 41, text: "None" },
    ]);
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [q],
      new Map([[1, [40]]]),
    );
    assertStringIncludes(row ?? "", '"Nuts, dairy"');
  });

  test("escapes quotes in answer text per RFC 4180", () => {
    const q = question(5, "Quote", [{ id: 50, text: 'She said "hi"' }]);
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [q],
      new Map([[1, [50]]]),
    );
    assertStringIncludes(row ?? "", '"She said ""hi"""');
  });

  test("ignores answer IDs that do not belong to any of the provided questions", () => {
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [SIZE_Q],
      new Map([[1, [999, 10]]]), // 999 is stale / unknown, 10 matches Small
    );
    // The unknown answer must not leak into the column or appear as "undefined"
    expect(row!.endsWith(",Small")).toBe(true);
    assert(!(row ?? "").includes("undefined"));
  });

  test("leaves a free-text cell empty when the attendee wrote nothing", () => {
    const [, row] = generateAttendeesCsv(
      [testAttendee({ id: 1 })],
      false,
      undefined,
      { attendeeAnswerMap: new Map(), questions: [NOTES_Q] },
    ).split("\n");
    expect(row!.endsWith(",")).toBe(true);
  });

  test("omits question columns entirely when questionData is not provided", () => {
    const [header, row] = generateAttendeesCsv([testAttendee()]).split("\n");
    // The header should end with "Ticket URL" — no trailing question columns
    expect(header!.endsWith("Ticket URL")).toBe(true);
    // And the data row should have the same number of cells (commas) as the header
    expect(row!.split(",").length).toBe(header!.split(",").length);
  });

  /** Line answers in a CSV: the question, each attendee's answers, how the
   * header ends, and how Alice's and Bob's rows end. */
  const LINE_CSVS: [
    string,
    QuestionWithAnswers,
    [number, ReturnType<typeof ticketAnswer>[]][],
    string,
    [string, string],
  ][] = [
    [
      "a question for each ticket takes one column for each ticket, up to the most tickets an attendee holds",
      PUPIL_Q,
      [
        [
          1,
          [
            ticketAnswer(4, "Ava", { quantity: 2 }),
            ticketAnswer(4, "Amy", { quantity: 2, unit: 1 }),
          ],
        ],
        [2, [ticketAnswer(4, "Ben")]],
      ],
      ",Pupil name (ticket 1),Pupil name (ticket 2)",
      [",Ava,Amy", ",Ben,"],
    ],
    [
      "a question for each line takes one column",
      GLOW_Q,
      [[1, [ticketAnswer(5, "Kit")]]],
      ",Glow name",
      [",Kit", ","],
    ],
    [
      "an answer for a ticket that is no longer booked stays out of the ticket columns",
      PUPIL_Q,
      [[1, [ticketAnswer(4, "Ava"), ticketAnswer(4, "Amy", { unit: 1 })]]],
      ",Pupil name (ticket 1)",
      [",Ava", ","],
    ],
    [
      "a question for each ticket that no attendee answered still takes its first column",
      PUPIL_Q,
      [],
      ",Pupil name (ticket 1)",
      [",", ","],
    ],
  ];

  for (const [name, asked, answers, headerEnd, rowEnds] of LINE_CSVS) {
    test(name, () => {
      const lines = lineAnswerCsv([asked], answers).slice(0, 3);
      const ends = [headerEnd, ...rowEnds];

      expect(lines.map((line, at) => line.slice(-ends[at]!.length))).toEqual(
        ends,
      );
    });
  }

  /** One attendee with two booking rows of one listing: the rows that the
   * export holds, the attendee's answers, and how each row ends. A row holds
   * only the answers of its own booking row. */
  const ROW_CSVS: [
    string,
    QuestionWithAnswers,
    Partial<Attendee>[],
    ReturnType<typeof ticketAnswer>[],
    string[],
  ][] = [
    [
      "a standalone row and a package row",
      PUPIL_Q,
      [{ package_group_id: 0 }, { package_group_id: 9 }],
      [ticketAnswer(4, "Ann"), ticketAnswer(4, "Ben", { packageGroupId: 9 })],
      [",Ann", ",Ben"],
    ],
    [
      "the same listing under two parents",
      GLOW_Q,
      [{ parent_listing_id: 3 }, { parent_listing_id: 4 }],
      [
        ticketAnswer(5, "Kit", { parentListingId: 3 }),
        ticketAnswer(5, "Kim", { parentListingId: 4 }),
      ],
      [",Kit", ",Kim"],
    ],
    [
      "the same listing under two parents that each sit in a package",
      GLOW_Q,
      [
        { package_group_id: 9, parent_listing_id: 3 },
        { package_group_id: 9, parent_listing_id: 4 },
      ],
      [
        ticketAnswer(5, "Kit", { parentListingId: 3 }),
        ticketAnswer(5, "Kim", { parentListingId: 4 }),
      ],
      [",Kit", ",Kim"],
    ],
    [
      "the same listing on two dates",
      PUPIL_Q,
      [{ date: "2026-06-01" }, { date: "2026-06-08" }],
      [
        ticketAnswer(4, "Ann", { startAt: "2026-06-01T00:00:00Z" }),
        ticketAnswer(4, "Ben", { startAt: "2026-06-08T00:00:00Z" }),
      ],
      [",Ann", ",Ben"],
    ],
  ];

  for (const [name, asked, rows, answers, rowEnds] of ROW_CSVS) {
    test(`an attendee with ${name} exports each row with its own answers`, () => {
      const lines = generateAttendeesCsv(
        rows.map((row) => testAttendee({ id: 1, ...row })),
        false,
        undefined,
        {
          attendeeAnswerMap: new Map(),
          lineAnswerMap: new Map([[1, answers]]),
          questions: [asked],
        },
      ).split("\n");

      expect(
        lines.slice(1).map((line, at) => line.slice(-rowEnds[at]!.length)),
      ).toEqual(rowEnds);
      expect(lines.slice(1).map((line) => line.split(",").length)).toEqual([
        lines[0]!.split(",").length,
        lines[0]!.split(",").length,
      ]);
    });
  }
});
