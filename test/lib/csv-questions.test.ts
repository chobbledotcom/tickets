import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import type { Attendee } from "#lib/types.ts";
import { generateAttendeesCsv } from "#templates/csv.ts";

const makeAttendee = (id: number, name: string): Attendee => ({
  address: "",
  attachment_downloads: 0,
  checked_in: false,
  created: "2024-01-01T00:00:00Z",
  date: null,
  email: "test@test.com",
  event_id: 1,
  id,
  name,
  payment_id: "",
  phone: "",
  pii_blob: "",
  price_paid: "0",
  quantity: 1,
  refunded: false,
  special_instructions: "",
  ticket_token: "ABC123",
  ticket_token_index: "idx",
});

const makeQuestions = (): QuestionWithAnswers[] => [
  {
    answers: [
      { id: 10, question_id: 1, sort_order: 0, text: "Small" },
      { id: 11, question_id: 1, sort_order: 1, text: "Large" },
    ],
    id: 1,
    text: "T-shirt Size",
  },
  {
    answers: [
      { id: 20, question_id: 2, sort_order: 0, text: "None" },
      { id: 21, question_id: 2, sort_order: 1, text: "Vegetarian" },
    ],
    id: 2,
    text: "Dietary Requirements",
  },
];

describe("CSV with custom questions", () => {
  beforeEach(() => {
    setEffectiveDomainForTest("example.com");
  });

  afterEach(() => {
    resetEffectiveDomain();
  });

  test("includes question columns in header", () => {
    const attendees = [makeAttendee(1, "Alice")];
    const questions = makeQuestions();
    const answerMap = new Map([[1, [10, 20]]]);

    const csv = generateAttendeesCsv(attendees, false, undefined, {
      attendeeAnswerMap: answerMap,
      questions,
    });

    const header = csv.split("\n")[0]!;
    expect(header).toContain("T-shirt Size");
    expect(header).toContain("Dietary Requirements");
  });

  test("includes correct answer values per attendee", () => {
    const attendees = [makeAttendee(1, "Alice"), makeAttendee(2, "Bob")];
    const questions = makeQuestions();
    const answerMap = new Map([
      [1, [10, 21]], // Alice: Small, Vegetarian
      [2, [11, 20]], // Bob: Large, None
    ]);

    const csv = generateAttendeesCsv(attendees, false, undefined, {
      attendeeAnswerMap: answerMap,
      questions,
    });

    const lines = csv.split("\n");
    expect(lines[1]).toContain("Small");
    expect(lines[1]).toContain("Vegetarian");
    expect(lines[2]).toContain("Large");
    expect(lines[2]).toContain("None");
  });

  test("uses empty string for attendee with no answers", () => {
    const attendees = [makeAttendee(1, "Alice")];
    const questions = makeQuestions();
    const answerMap = new Map<number, number[]>();

    const csv = generateAttendeesCsv(attendees, false, undefined, {
      attendeeAnswerMap: answerMap,
      questions,
    });

    const lines = csv.split("\n");
    // Last two values should be empty (no answers)
    expect(lines[1]!.endsWith(",,")).toBe(true);
  });

  test("generates normal CSV when no questionData provided", () => {
    const attendees = [makeAttendee(1, "Alice")];
    const csv = generateAttendeesCsv(attendees);
    const header = csv.split("\n")[0]!;
    expect(header).not.toContain("T-shirt");
  });
});
