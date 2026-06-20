import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { generateAttendeesCsv } from "#routes/admin/attendees-csv.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { testAttendee } from "#test-utils";

/** Build a question with answers that each have a distinct numeric id. */
const question = (
  id: number,
  text: string,
  answers: { id: number; text: string }[],
): QuestionWithAnswers => ({
  answers: answers.map((a, i) => ({
    id: a.id,
    question_id: id,
    sort_order: i,
    text: a.text,
  })),
  display_type: "radio",
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

const csvWithQuestions = (
  attendees: Parameters<typeof generateAttendeesCsv>[0],
  questions: QuestionWithAnswers[],
  attendeeAnswerMap: Map<number, number[]>,
): string[] =>
  generateAttendeesCsv(attendees, false, undefined, {
    attendeeAnswerMap,
    questions,
  }).split("\n");

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
    const freeTextQ: QuestionWithAnswers = {
      answers: [],
      display_type: "free_text",
      id: 3,
      text: "Notes",
    };
    const [header, row] = generateAttendeesCsv(
      [testAttendee({ id: 1 })],
      false,
      undefined,
      {
        attendeeAnswerMap: new Map(),
        questions: [freeTextQ],
        textAnswerMap: new Map([[1, new Map([[3, "Coeliac, no nuts"]])]]),
      },
    ).split("\n");
    expect(header!.endsWith(",Notes")).toBe(true);
    expect(row!.endsWith(',"Coeliac, no nuts"')).toBe(true);
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
    expect(header).toContain('"Name, as printed on ticket"');
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
    expect(row).toContain('"Nuts, dairy"');
  });

  test("escapes quotes in answer text per RFC 4180", () => {
    const q = question(5, "Quote", [{ id: 50, text: 'She said "hi"' }]);
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [q],
      new Map([[1, [50]]]),
    );
    expect(row).toContain('"She said ""hi"""');
  });

  test("ignores answer IDs that do not belong to any of the provided questions", () => {
    const [, row] = csvWithQuestions(
      [testAttendee({ id: 1 })],
      [SIZE_Q],
      new Map([[1, [999, 10]]]), // 999 is stale / unknown, 10 matches Small
    );
    // The unknown answer must not leak into the column or appear as "undefined"
    expect(row!.endsWith(",Small")).toBe(true);
    expect(row).not.toContain("undefined");
  });

  test("omits question columns entirely when questionData is not provided", () => {
    const [header, row] = generateAttendeesCsv([testAttendee()]).split("\n");
    // The header should end with "Ticket URL" — no trailing question columns
    expect(header!.endsWith("Ticket URL")).toBe(true);
    // And the data row should have the same number of cells (commas) as the header
    expect(row!.split(",").length).toBe(header!.split(",").length);
  });
});
