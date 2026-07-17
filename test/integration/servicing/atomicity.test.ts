/**
 * Servicing §3/§4 — create/update atomicity (compensating rollback).
 *
 * `createServicingEvent` commits the attendee + bookings in one atomic batch,
 * then saves answers and logs activity in a separate batch; `updateServicingEvent`
 * edits bookings in one batch then saves answers in another. Batches don't nest
 * reliably on the edge runtime, so neither can wrap the whole thing in one outer
 * transaction. Instead, a failed post-create/post-edit side effect is compensated
 * — the created attendee is deleted (create), or the pre-edit state is restored
 * (update) — so no half-saved service event ever remains.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withPoisonedTransactionWrite } from "#test-utils/db-poison.ts";
import {
  createServicingHold,
  createTestServicingEvent,
  expectRejects,
  getServicingEvent,
  servicingRowsForListing,
  updateServicingEvent,
} from "#test-utils/servicing.ts";

// jscpd:ignore-end

/** Fail the FIRST `attendee_answers` write (the answer save), so the
 *  create/update compensation runs. */
const withAnswerSaveFailure = withPoisonedTransactionWrite(
  (sql) => sql.includes("attendee_answers"),
  "answer save boom",
);

/** Fail the FIRST `INSERT INTO attendee_answers`, letting the preceding
 *  clear (`DELETE FROM attendee_answers`) run on the same transaction first —
 *  the exact window in which the free-text-loss bug lived: the delete drops the
 *  old answers, then the re-insert fails and rolls the delete back, so the
 *  compensation must restore the WHOLE prior answer set (choice + free-text),
 *  not just its choice half. */
const withAnswerInsertFailure = withPoisonedTransactionWrite(
  (sql) => sql.includes("INSERT INTO attendee_answers"),
  "answer insert boom",
);

/** Attach a free_text and a radio question to a listing, returning both ids. */
const attachTextAndChoiceQuestions = async (
  listingId: number,
): Promise<{
  textQuestionId: number;
  choiceQuestionId: number;
  choiceAnswerId: number;
}> => {
  const { answersTable, questionsTable } = await import(
    "#shared/db/questions/tables.ts"
  );
  const { questionListings } = await import("#shared/db/questions/queries.ts");
  const textQuestion = await questionsTable.insert({
    assignAll: false,
    displayType: "free_text",
    text: "Boiler notes?",
  });
  const choiceQuestion = await questionsTable.insert({
    assignAll: false,
    displayType: "radio",
    text: "Boiler model?",
  });
  const choiceAnswer = await answersTable.insert({
    questionId: choiceQuestion.id,
    sortOrder: 0,
    text: "Vaillant",
  });
  for (const q of [textQuestion.id, choiceQuestion.id]) {
    await questionListings.setIds(q, [listingId]);
  }
  return {
    choiceAnswerId: choiceAnswer.id,
    choiceQuestionId: choiceQuestion.id,
    textQuestionId: textQuestion.id,
  };
};

describeWithEnv(
  "servicing — create/update compensate on side-effect failure",
  { db: true },
  () => {
    test("update rollback restores a prior FREE-TEXT answer, not just choice answers", async () => {
      // Regression: updateServicingEvent snapshotted answers with
      // { texts: false }, so restoreServicingState re-saved only choice ids and
      // dropped any free-text answer saveAttendeeAnswers had already deleted —
      // even though the edit is reported as rolled back.
      const { id, listing } = await createServicingHold({
        listing: { name: "L" },
      });
      const { textQuestionId, choiceAnswerId } =
        await attachTextAndChoiceQuestions(listing.id);
      const { saveAttendeeAnswers } = await import(
        "#shared/db/questions/attendee-answers/save.ts"
      );
      const { getAttendeeTextAnswers } = await import(
        "#shared/db/questions/attendee-answers/reads.ts"
      );
      // Seed a free-text answer on the servicing event.
      await saveAttendeeAnswers(
        new Map([
          [
            id,
            {
              answerIds: [],
              textAnswers: [
                { questionId: textQuestionId, text: "Serial 12345" },
              ],
            },
          ],
        ]),
      );
      const key = await getTestPrivateKey();
      expect((await getAttendeeTextAnswers(id, key)).get(textQuestionId)).toBe(
        "Serial 12345",
      );
      // Edit supplies a CHOICE answer, so the edit's saveAttendeeAnswers clears
      // (deleting the free-text) then inserts — and the insert is poisoned.
      await withAnswerInsertFailure(async () => {
        await expectRejects(
          updateServicingEvent(id, {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            name: "Changed",
            questionAnswers: [{ answerId: choiceAnswerId }],
          }),
          /answer insert boom/,
        );
      });
      // The edit rolled back: name is unchanged AND the free-text answer is
      // intact (it was restored, not dropped).
      const after = await getServicingEvent(id);
      expect(after?.name).toBe("Boiler Service");
      expect((await getAttendeeTextAnswers(id, key)).get(textQuestionId)).toBe(
        "Serial 12345",
      );
    });

    test("create deletes the attendee when answer saving fails (no partial event)", async () => {
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          createTestServicingEvent({
            bookings: [{ listingId: listing.id, quantity: 2 }],
            name: "Doomed Service",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      // The compensating delete removed the attendee and its booking, so no
      // half-saved service event holds the listing's capacity.
      expect((await servicingRowsForListing(listing.id)).length).toBe(0);
      const { queryOne } = await import("#shared/db/client.ts");
      const row = await queryOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM attendees WHERE kind = 'servicing'",
      );
      expect(Number(row?.c ?? 0)).toBe(0);
    });

    test("update restores the prior state when answer saving fails (no half-applied edit)", async () => {
      // Uses a DAILY listing with a date so the restore path's `start_at`
      // branch (a booking with a set date) is covered alongside the dateless
      // test below (which covers the `null` start_at path).
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        name: "Daily Room",
      });
      const event = await createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Original",
      });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          updateServicingEvent(event.id, {
            bookings: [
              { date: "2099-07-01", listingId: listing.id, quantity: 5 },
            ],
            name: "Changed",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      // The edit (qty 2→5, name→Changed) was rolled back: the original booking
      // (qty 2) and name survive, so the edit didn't land half-applied.
      const after = await getServicingEvent(event.id);
      expect(after?.name).toBe("Original");
      expect(after?.bookings[0]?.quantity).toBe(2);
    });

    test("update restores a dateless (standard) listing booking when answer saving fails", async () => {
      // Standard listings have start_at = null, exercising the restore path's
      // null-date branch (desiredLinesFromExisting handles a null start_at by
      // setting date to null — the restore must not break on it).
      const { createTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
      const { createTestServicingEvent } = await import(
        "#test-utils/servicing.ts"
      );
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Standard Room",
      });
      const event = await createTestServicingEvent({
        bookings: [{ listingId: listing.id, quantity: 3 }],
        name: "Standard Hold",
      });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          updateServicingEvent(event.id, {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            name: "Changed",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      const after = await getServicingEvent(event.id);
      expect(after?.name).toBe("Standard Hold");
      expect(after?.bookings[0]?.quantity).toBe(3);
    });
  },
);
