/** The immutable receipt of the answers a buyer gave: the wording they saw is
 * kept as first written, an operator's later edits cannot rewrite it, and old
 * bookings without a receipt fall back to the current-label reader. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  loadSubmittedAnswerLines,
  saveSubmittedAnswerReceipts,
} from "#shared/email/answer-receipt.ts";
import type { AnswerLine } from "#shared/email/answers.ts";
import type { EmailEntry } from "#shared/email.ts";
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
});
