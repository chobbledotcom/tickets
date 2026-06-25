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
  renderAdminPage,
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

describeWithEnv("servicing §11 — custom questions", { db: true }, () => {
  test("create-mode loader returns the selected listings' questions (no attendee id)", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { questionId } = await attachQuestion(listing.id);
    const { questions } = await getQuestionsWithListingIds([listing.id]);
    expect(questions.map((q) => q.id)).toContain(questionId);
  });

  test("answers entered at creation are saved against the new servicing id", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { questionId, answerId } = await attachQuestion(listing.id);
    const { id } = await createServicingHold({
      listing: { name: "L" },
      questionAnswers: [{ answerId, questionId }],
    });
    expect(await answersFor(id)).toContainEqual({
      answer_id: answerId,
      question_id: questionId,
    });
  });

  test("editing a servicing event loads and saves its answers", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { questionId, answerId } = await attachQuestion(listing.id);
    const { id } = await createServicingHold({
      listing: { name: "L" },
      questionAnswers: [{ answerId, questionId }],
    });
    // Reopen via the edit page: the existing answer renders as a selected input.
    const editBody = await renderAdminPage(`/admin/servicing/${id}`);
    expect(editBody).toContain("Boiler model?");
    expect(editBody).toContain("checked");

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
});
