/**
 * Servicing §11 — custom questions.
 *
 * A servicing event can be asked the same custom questions a customer is —
 * e.g. "which boiler model?". The create-mode loader (keyed by listing ids,
 * no attendee id) returns the listings' questions, answers entered at creation
 * are saved against the new servicing id, and editing loads + saves them.
 *
 * Implementation contract (test-first):
 *   - The servicing create/edit routes reuse `getQuestionsWithListingIds` for
 *     create-mode and `loadAttendeeQuestionData` for edit-mode (same loaders as
 *     the attendee form), and the shared answer-save step runs inside the
 *     servicing create/edit core.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions.ts";
import {
  createServicingHold,
  createTestListing,
  describeWithEnv,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

/** Attach a single radio "Boiler model?" question to a listing. */
const attachQuestion = async (
  listingId: number,
): Promise<{ questionId: number; answerId: number }> => {
  const { answersTable, listingQuestionsTable, questionsTable } = await import(
    "#shared/db/questions.ts"
  );
  const question = await questionsTable.insert({
    assignAll: false,
    displayType: "radio",
    text: "Boiler model?",
  });
  const answer = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Vaillant",
  });
  await listingQuestionsTable.insert({
    listingId,
    questionId: question.id,
    sortOrder: 0,
  });
  const questionId = question.id;
  const answerId = answer.id;
  return { answerId, questionId };
};

const answersFor = (attendeeId: number) =>
  queryAll<{ question_id: number; answer_id: number }>(
    "SELECT question_id, answer_id FROM attendee_answers WHERE attendee_id = ?",
    [attendeeId],
  );

/** Listing "L" with a "Boiler model?" question and a servicing hold that already
 *  answered it — the fixture for the create-saved and edit-loaded answer tests. */
const listingWithAnsweredHold = async () => {
  const listing = await createTestListing({ maxAttendees: 10, name: "L" });
  const { questionId, answerId } = await attachQuestion(listing.id);
  const { id } = await createServicingHold({
    listing: { name: "L" },
    questionAnswers: [{ answerId, questionId }],
  });
  return { answerId, id, listing, questionId };
};

describeWithEnv("servicing §11 — custom questions", { db: true }, () => {
  test("create-mode loader returns the selected listings' questions (no attendee id)", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { questionId } = await attachQuestion(listing.id);
    const { questions } = await getQuestionsWithListingIds([listing.id]);
    expect(questions.map((q) => q.id)).toContain(questionId);
  });

  test("answers entered at creation are saved against the new servicing id", async () => {
    const { id, questionId, answerId } = await listingWithAnsweredHold();
    expect(await answersFor(id)).toContainEqual({
      answer_id: answerId,
      question_id: questionId,
    });
  });

  test("editing a servicing event saves its answers", async () => {
    const { id, listing, answerId, questionId } =
      await listingWithAnsweredHold();
    // Save an edit with the answer still selected: it persists (no answer drop).
    await updateServicingEvent(id, {
      bookings: [{ listingId: listing.id, quantity: 1 }],
      name: "Boiler Service",
      questionAnswers: [{ answerId, questionId }],
    });
    const rows = await answersFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.answer_id).toBe(answerId);
  });

  test("saving a servicing event without questionAnswers preserves existing answers", async () => {
    // Regression: the admin form no longer renders question fields, so
    // updateServicingEvent receives no questionAnswers. Previously this wiped
    // all stored answers because saveAttendeeAnswers deletes before re-inserting.
    const { id, listing, answerId, questionId } =
      await listingWithAnsweredHold();
    // Omit questionAnswers entirely — simulates a form POST with no question fields.
    await updateServicingEvent(id, {
      bookings: [{ listingId: listing.id, quantity: 1 }],
      name: "Boiler Service Updated",
    });
    const rows = await answersFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.answer_id).toBe(answerId);
    expect(rows[0]?.question_id).toBe(questionId);
  });
});
