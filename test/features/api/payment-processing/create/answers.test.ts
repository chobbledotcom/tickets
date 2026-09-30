import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { questionsTable } from "#db/questions/tables.ts";
import {
  type CreatedEntry,
  saveSessionAnswers,
} from "#routes/api/payment-processing/create.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";

const bookedEntry = async (): Promise<CreatedEntry> => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Answer buyer",
    "answers@example.com",
  );
  const loaded = await getListingWithCount(listing.id);
  if (loaded === null) throw new Error(`Listing ${listing.id} was not created`);
  return { attendee, listing: loaded };
};

const saveAndReadAnswers = async (
  entry: CreatedEntry,
  answers: Parameters<typeof bookingIntent>[1],
) => {
  await saveSessionAnswers(
    [entry],
    bookingIntent([{ e: entry.listing.id, p: 0, q: 1 }], answers),
  );
  return (
    await getDb().execute({
      args: [entry.attendee.id],
      sql: "SELECT question_id, answer_id, string_id FROM attendee_answers WHERE attendee_id = ?",
    })
  ).rows;
};

describeWithEnv("paid booking answer saves", { db: true }, () => {
  test("saves a choice answer missing from the paid-order snapshot", async () => {
    const entry = await bookedEntry();
    const { answerId, questionId } = await createQuestionWithAnswer();
    const saved = await saveAndReadAnswers(entry, {
      listingAnswerIds: { [entry.listing.id]: [answerId] },
    });
    expect(saved).toEqual([
      { answer_id: answerId, question_id: questionId, string_id: null },
    ]);
  });

  test("saves a text answer missing from the paid-order snapshot", async () => {
    const entry = await bookedEntry();
    const question = await questionsTable.insert({
      displayType: "free_text",
      text: "Add detail",
    });
    const stringId = (await getOrCreateStringIds(["The saved detail"])).get(
      "The saved detail",
    );
    if (stringId === undefined) throw new Error("Text answer was not interned");
    const saved = await saveAndReadAnswers(entry, {
      listingTextAnswerIds: {
        [entry.listing.id]: [{ q: question.id, s: stringId }],
      },
    });
    expect(saved).toEqual([
      { answer_id: null, question_id: question.id, string_id: stringId },
    ]);
  });
});

describeWithEnv("paid booking answers at booking", { db: true }, () => {
  const recorded = async (entry: CreatedEntry) =>
    (
      await getDb().execute({
        args: [entry.attendee.id],
        sql: "SELECT question_id, answer_id FROM answers_at_booking WHERE attendee_id = ?",
      })
    ).rows;

  test("records the chosen answer as the answer at booking", async () => {
    const entry = await bookedEntry();
    const { answerId, questionId } = await createQuestionWithAnswer([
      entry.listing.id,
    ]);
    await saveAndReadAnswers(entry, {
      listingAnswerIds: { [entry.listing.id]: [answerId] },
    });
    expect(await recorded(entry)).toEqual([
      { answer_id: answerId, question_id: questionId },
    ]);
  });

  test("records the asked questions of an order that answered none", async () => {
    const entry = await bookedEntry();
    const { questionId } = await createQuestionWithAnswer([entry.listing.id]);
    await saveAndReadAnswers(entry, {});
    expect(await recorded(entry)).toEqual([
      { answer_id: null, question_id: questionId },
    ]);
  });
});
