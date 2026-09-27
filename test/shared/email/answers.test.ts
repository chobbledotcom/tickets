/** The email answer lines: choices load from the database, free-text answers
 * arrive from the sender that holds them, and each entry sees only the
 * questions its own listing asks. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { questionListings } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  type FreeTextAnswers,
  loadOrderAnswerLines,
  orderAnswerLines,
  type QuestionContext,
} from "#shared/email/answers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  makeTestEntry as makeEntry,
  testAnswer,
} from "#test-utils/factories.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

interface SeededQuestion {
  answerId: number;
  questionId: number;
}

/** One choice question with an extra chosen option, assigned to listings. */
const seedChoiceQuestion = async (
  assignedTo: number[],
  text = "Any allergies?",
): Promise<SeededQuestion> => {
  const question = await questionsTable.insert({
    displayType: "radio",
    text,
  });
  const chosen = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Shellfish",
  });
  await questionListings.setIds(question.id, assignedTo);
  return { answerId: chosen.id, questionId: question.id };
};

describeWithEnv("order answer lines", { db: true }, () => {
  const bookedBuyer = async (listingName: string) => {
    const listing = await createTestListing({ name: listingName });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Booked",
      "buyer@example.com",
    );
    return { attendee, listing };
  };

  /** A buyer who booked a listing and answered a choice question on it. */
  const buyerWithChosenAnswer = async (listingName: string) => {
    const { attendee, listing } = await bookedBuyer(listingName);
    const { answerId } = await seedChoiceQuestion([listing.id]);
    await saveAttendeeAnswers(new Map([[attendee.id, [answerId]]]));
    return { attendee, listing };
  };

  test("shows the chosen answer of a question the listing asks", async () => {
    const { attendee, listing } = await buyerWithChosenAnswer("Fete");

    const lines = await loadOrderAnswerLines([
      makeEntry({ id: listing.id, name: listing.name }, { id: attendee.id }),
    ]);

    expect(lines.get(attendee.id)?.get(listing.id)).toEqual([
      { question: "Any allergies?", text: "Shellfish" },
    ]);
  });

  test("keeps a question off a listing it was not assigned to", async () => {
    const { attendee, listing: asking } = await bookedBuyer("Asking");
    const other = await createTestListing({ name: "Other" });
    const { answerId } = await seedChoiceQuestion([asking.id]);
    await saveAttendeeAnswers(new Map([[attendee.id, [answerId]]]));

    const lines = await loadOrderAnswerLines([
      makeEntry({ id: other.id, name: other.name }, { id: attendee.id }),
    ]);

    expect(lines.get(attendee.id)?.get(other.id)).toEqual([]);
  });

  test("skips a question the attendee left unanswered", async () => {
    const { attendee, listing } = await bookedBuyer("Fete");
    await seedChoiceQuestion([listing.id]);

    const lines = await loadOrderAnswerLines([
      makeEntry({ id: listing.id }, { id: attendee.id }),
    ]);

    expect(lines.get(attendee.id)?.get(listing.id)).toEqual([]);
  });

  test("places each entry's answers under its own listing", async () => {
    const { attendee, listing: first } = await bookedBuyer("One");
    const second = await createTestListing({ name: "Two" });
    const onFirst = await seedChoiceQuestion([first.id], "Diet?");
    await seedChoiceQuestion([second.id], "Shirt size?");
    await saveAttendeeAnswers(new Map([[attendee.id, [onFirst.answerId]]]));

    const lines = await loadOrderAnswerLines([
      makeEntry({ id: first.id }, { id: attendee.id }),
      makeEntry({ id: second.id }, { id: attendee.id }),
    ]);

    expect(lines.get(attendee.id)?.get(first.id)).toEqual([
      { question: "Diet?", text: "Shellfish" },
    ]);
    expect(lines.get(attendee.id)?.get(second.id)).toEqual([]);
  });

  test("spends fixed database reads however many entries the order has", async () => {
    const { attendee, listing } = await buyerWithChosenAnswer("Fete");
    const entry = makeEntry({ id: listing.id }, { id: attendee.id });

    const calls = await countDatabaseCalls(2, () =>
      loadOrderAnswerLines([entry, entry]),
    );

    expect(calls).toBe(2);
  });
});

describe("order answer lines from staged question data", () => {
  const question = (
    id: number,
    text: string,
    answers: { id: number; text: string }[],
    opts: { assignAll?: boolean; displayType?: "radio" | "free_text" } = {},
  ) => ({
    answers: answers.map((a) =>
      testAnswer({ id: a.id, question_id: id, text: a.text }),
    ),
    assign_all: opts.assignAll ?? false,
    display_type: opts.displayType ?? "radio",
    id,
    sort_order: id,
    text,
  });

  const chosen = new Map([[7, [31, 32]]]);
  const ctx = (
    questions: QuestionWithAnswers[],
    freeTexts: FreeTextAnswers = new Map(),
  ): QuestionContext => ({
    chosenByAttendee: chosen,
    freeTexts,
    questionListingMap: new Map([
      [11, [101]],
      [12, [101]],
    ]),
    questions,
  });

  test("merges free-text answers with choice answers in question order", () => {
    const lines = orderAnswerLines(
      [makeEntry({ id: 101 }, { id: 7 })],
      ctx(
        [
          question(11, "Any allergies?", [{ id: 31, text: "Peanuts" }]),
          question(12, "Anything else?", [], { displayType: "free_text" }),
        ],
        new Map([[12, "Coming by bus"]]),
      ),
    );

    expect(lines.get(7)?.get(101)).toEqual([
      { question: "Any allergies?", text: "Peanuts" },
      { question: "Anything else?", text: "Coming by bus" },
    ]);
  });

  test("asks an assign-all question on every listing", () => {
    const lines = orderAnswerLines(
      [makeEntry({ id: 999 }, { id: 7 })],
      ctx([
        question(11, "Club member?", [{ id: 31, text: "Yes" }], {
          assignAll: true,
        }),
      ]),
    );

    expect(lines.get(7)?.get(999)).toEqual([
      { question: "Club member?", text: "Yes" },
    ]);
  });

  test("omits a free-text question when no text was held for it", () => {
    const lines = orderAnswerLines(
      [makeEntry({ id: 101 }, { id: 7 })],
      ctx([question(12, "Anything else?", [], { displayType: "free_text" })]),
    );

    expect(lines.get(7)?.get(101)).toEqual([]);
  });
});
