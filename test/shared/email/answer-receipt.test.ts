/** The immutable receipt of the answers a buyer gave: the wording they saw is
 * kept as first written, an operator's later edits cannot rewrite it, and old
 * bookings without a receipt fall back to the current-label reader. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  loadSubmittedAnswerLines,
  loadSubmittedFreeTexts,
  saveSubmittedAnswerReceipts,
  submittedAnswersForCheckout,
} from "#shared/email/answer-receipt.ts";
import type { AnswerLine } from "#shared/email/answers.ts";
import type { EmailEntry } from "#shared/email.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";

/** One listing with a free-text question, booked through the real free path
 * with the answer given, so the receipt is the one production writes. */
const bookedWithFreeText = async (
  answer: string,
): Promise<{ entry: EmailEntry; listingId: number; questionId: number }> => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const questionId = await createFreeTextQuestion([listing.id]);
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Booked",
    `${listing.slug}@example.com`,
    1,
    "",
    { [`question_${questionId}`]: answer },
  );
  const loaded = await getListingWithCount(listing.id);
  return {
    entry: { attendee, listing: loaded! },
    listingId: listing.id,
    questionId,
  };
};

/** One listing booked with no questions asked of it. */
const bookedLine = async (): Promise<{
  entry: EmailEntry;
  listingId: number;
}> => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Booked",
    `${listing.slug}@example.com`,
  );
  const loaded = await getListingWithCount(listing.id);
  return { entry: { attendee, listing: loaded! }, listingId: listing.id };
};

/** A second listing that no booking points at. */
const anotherListing = async () => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const found = await getListingWithCount(listing.id);
  if (found === null) throw new Error("The created listing vanished");
  return found;
};

/** Cut a receipt line's tie to its interned string, the way a corrupted row
 * reads after the sealed text vanished. */
const severStringId = async (attendeeId: number): Promise<void> => {
  await execute(
    "UPDATE submitted_answer_receipt_lines SET string_id = NULL WHERE attendee_id = ?",
    [attendeeId],
  );
};

/** A select question fixture with one option, active unless deactivated. */
const selectQuestion = (
  id: number,
  answerId: number,
  active = true,
): QuestionWithAnswers => ({
  answers: [
    {
      active,
      id: answerId,
      question_id: id,
      sort_order: 0,
      text: `Option ${answerId}`,
    },
  ],
  assign_all: true,
  display_type: "select",
  id,
  text: `Question ${id}`,
});

/** A free-text question fixture assigned to specific listings unless global. */
const freeQuestion = (id: number): QuestionWithAnswers => ({
  answers: [],
  assign_all: false,
  display_type: "free_text",
  id,
  text: `Question ${id}`,
});

/** The receipt lines for one booked line, with its free text supplied. */
const receiptLinesOf = async (
  booked: { entry: EmailEntry; listingId: number; questionId: number },
  text: string,
): Promise<AnswerLine[]> => {
  const lines = await loadSubmittedAnswerLines(
    [booked.entry],
    new Map([[booked.questionId, text]]),
  );
  return lines.get(booked.entry.attendee.id)?.get(booked.listingId) ?? [];
};

describeWithEnv("submitted answer receipts", { db: true }, () => {
  test("keeps the free-text wording the buyer saw", async () => {
    const booked = await bookedWithFreeText("Coming by bus");

    expect(await receiptLinesOf(booked, "Coming by bus")).toEqual([
      { question: "Anything else?", text: "Coming by bus" },
    ]);
  });

  test("an operator editing the question cannot rewrite the receipt", async () => {
    const booked = await bookedWithFreeText("Bringing a chair");
    await questionsTable.update(booked.questionId, { text: "Extra info?" });

    expect(await receiptLinesOf(booked, "Bringing a chair")).toEqual([
      { question: "Anything else?", text: "Bringing a chair" },
    ]);
  });

  test("keeps a chosen option's wording after the operator deletes it", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const question = await questionsTable.insert({
      displayType: "select",
      text: "Meal?",
    });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Soup",
    });
    await listingQuestions.setIds(listing.id, [question.id]);
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Booked",
      `${listing.slug}@example.com`,
      1,
      "",
      { [`question_${question.id}`]: String(answer.id) },
    );
    const loaded = await getListingWithCount(listing.id);
    const entry: EmailEntry = { attendee, listing: loaded! };
    await execute("DELETE FROM answers WHERE id = ?", [answer.id]);
    await execute("DELETE FROM questions WHERE id = ?", [question.id]);

    const lines = await loadSubmittedAnswerLines([entry]);

    expect(lines.get(entry.attendee.id)?.get(listing.id)).toEqual([
      { question: "Meal?", text: "Soup" },
    ]);
  });

  test("a booking with no answers keeps an empty receipt", async () => {
    const { entry, listingId } = await bookedLine();
    const lines = await loadSubmittedAnswerLines([entry]);

    expect(lines.get(entry.attendee.id)?.get(listingId)).toEqual([]);
  });

  test("an old booking without a receipt reads its current labels", async () => {
    const booked = await bookedWithFreeText("Coming by bus");
    // A booking from before receipts existed: remove what the free path
    // wrote, the way a pre-migration booking carries none.
    await execute("DELETE FROM submitted_answer_receipt_lines");
    await execute("DELETE FROM submitted_answer_receipts");

    expect(await receiptLinesOf(booked, "Coming by bus")).toEqual([
      { question: "Anything else?", text: "Coming by bus" },
    ]);
  });

  test("refuses a receipt that does not name the booked listing", async () => {
    const { entry } = await bookedLine();

    await expect(
      saveSubmittedAnswerReceipts(
        [entry],
        [{ answers: [], listingId: 999_999 }],
      ),
    ).rejects.toThrow("Missing checkout snapshot for listing");
  });

  test("a free-text receipt without its plaintext is a hard error", async () => {
    const { entry } = await bookedWithFreeText("Coming by bus");

    // Reading without the plaintext the sender must supply: the owner key
    // (admin resend) or the checkout snapshot (completion) is required.
    await expect(loadSubmittedAnswerLines([entry])).rejects.toThrow(
      "owner key or checkout snapshot",
    );
  });

  test("captures exactly what each listing asks, in server wording", () => {
    const snapshot = submittedAnswersForCheckout(
      [{ listingId: 7 }, { listingId: 9 }],
      {
        activeQuestions: [
          selectQuestion(1, 11),
          { ...selectQuestion(2, 22), assign_all: false },
          freeQuestion(3),
          { ...selectQuestion(6, 66), assign_all: false },
          selectQuestion(5, 55, false),
        ],
        answerIds: [11, 22, 66],
        textAnswers: [{ questionId: 3, text: "Typed" }],
      },
      new Map([
        [2, [7]],
        [3, [7]],
      ]),
    );

    expect(snapshot).toEqual([
      {
        answers: [
          {
            kind: "choice",
            question: "Question 1",
            questionId: 1,
            text: "Option 11",
          },
          {
            kind: "choice",
            question: "Question 2",
            questionId: 2,
            text: "Option 22",
          },
          {
            kind: "free_text",
            question: "Question 3",
            questionId: 3,
            text: "Typed",
          },
        ],
        listingId: 7,
      },
      {
        answers: [
          {
            kind: "choice",
            question: "Question 1",
            questionId: 1,
            text: "Option 11",
          },
        ],
        listingId: 9,
      },
    ]);
  });

  test("rejects an answer selection that does not match the choice questions", () => {
    expect(() =>
      submittedAnswersForCheckout(
        [{ listingId: 1 }],
        {
          activeQuestions: [selectQuestion(1, 11)],
          answerIds: [],
          textAnswers: [],
        },
        new Map(),
      ),
    ).toThrow("Invalid checkout answer selection");
  });

  test("empty booking lists save and read as no-ops", async () => {
    await saveSubmittedAnswerReceipts([], []);

    expect(await loadSubmittedAnswerLines([])).toEqual(new Map());
  });

  test("re-saving a booking never rewrites or duplicates its receipt", async () => {
    const booked = await bookedWithFreeText("Coming by bus");

    await saveSubmittedAnswerReceipts(
      [booked.entry],
      [
        {
          answers: [
            {
              kind: "free_text",
              question: "Rewritten?",
              questionId: booked.questionId,
              text: "Changed my mind",
            },
          ],
          listingId: booked.listingId,
        },
      ],
    );

    expect(await receiptLinesOf(booked, "Coming by bus")).toEqual([
      { question: "Anything else?", text: "Coming by bus" },
    ]);
  });

  test("refuses a second receipt for the same attendee on another listing", async () => {
    const booked = await bookedWithFreeText("Coming by bus");
    const other = await anotherListing();

    await expect(
      saveSubmittedAnswerReceipts(
        [{ attendee: booked.entry.attendee, listing: other }],
        [{ answers: [], listingId: other.id }],
      ),
    ).rejects.toThrow("Receipt belongs to another listing");
  });

  test("refuses to read a receipt against a booking on another listing", async () => {
    const booked = await bookedWithFreeText("Coming by bus");
    const other = await anotherListing();

    await expect(
      loadSubmittedAnswerLines([
        { attendee: booked.entry.attendee, listing: other },
      ]),
    ).rejects.toThrow("Receipt belongs to another listing");
  });

  test("a free-text receipt without its interned string is a hard error", async () => {
    const booked = await bookedWithFreeText("Coming by bus");
    await severStringId(booked.entry.attendee.id);

    await expect(
      loadSubmittedAnswerLines(
        [booked.entry],
        new Map([[booked.questionId, "Coming by bus"]]),
      ),
    ).rejects.toThrow("Missing submitted text receipt");
  });

  test("the owner key reads the free texts the buyer submitted", async () => {
    const booked = await bookedWithFreeText("Coming by bus");

    const texts = await loadSubmittedFreeTexts(
      [booked.entry],
      await getTestPrivateKey(),
    );

    expect(texts.get(booked.questionId)).toBe("Coming by bus");
  });

  test("a free-text receipt without its sealed text is a hard error for the owner key", async () => {
    const booked = await bookedWithFreeText("Coming by bus");
    await severStringId(booked.entry.attendee.id);

    await expect(
      loadSubmittedFreeTexts([booked.entry], await getTestPrivateKey()),
    ).rejects.toThrow("Missing submitted text receipt");
  });

  test("a booking without answers contributes no free texts", async () => {
    const { entry } = await bookedLine();

    expect(
      await loadSubmittedFreeTexts([entry], await getTestPrivateKey()),
    ).toEqual(new Map());
  });
});
