import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type CreatedEntry,
  saveSessionAnswers,
} from "#routes/api/payment-processing/create.ts";
import { getDb } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
  return { attendee, listing: loaded } as CreatedEntry;
};

describeWithEnv("paid booking answer saves", { db: true }, () => {
  test("saves choice answers when there are no text answers", async () => {
    const entry = await bookedEntry();
    const question = await questionsTable.insert({
      displayType: "radio",
      text: "Choose one",
    });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Chosen",
    });
    await saveSessionAnswers(
      [entry],
      bookingIntent([{ e: entry.listing.id, p: 0, q: 1 }], {
        listingAnswerIds: { [entry.listing.id]: [answer.id] },
      }),
      {
        questionIdByAnswerId: new Map([[answer.id, question.id]]),
        textQuestionIds: new Set(),
      },
    );
    const saved = await getDb().execute({
      args: [entry.attendee.id],
      sql: "SELECT question_id, answer_id, string_id FROM attendee_answers WHERE attendee_id = ?",
    });
    expect(saved.rows).toEqual([
      { answer_id: answer.id, question_id: question.id, string_id: null },
    ]);
  });

  test("saves a valid text answer when there are no choice answers", async () => {
    const entry = await bookedEntry();
    const question = await questionsTable.insert({
      displayType: "free_text",
      text: "Add detail",
    });
    const stringId = (await getOrCreateStringIds(["The saved detail"])).get(
      "The saved detail",
    );
    if (stringId === undefined) throw new Error("Text answer was not interned");
    await saveSessionAnswers(
      [entry],
      bookingIntent([{ e: entry.listing.id, p: 0, q: 1 }], {
        listingTextAnswerIds: {
          [entry.listing.id]: [{ q: question.id, s: stringId }],
        },
      }),
      {
        questionIdByAnswerId: new Map(),
        textQuestionIds: new Set([question.id]),
      },
    );
    const saved = await getDb().execute({
      args: [entry.attendee.id],
      sql: "SELECT question_id, answer_id, string_id FROM attendee_answers WHERE attendee_id = ?",
    });
    expect(saved.rows).toEqual([
      { answer_id: null, question_id: question.id, string_id: stringId },
    ]);
  });
});
