import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee } from "#db/attendees/delete.ts";
import { execute, queryAll } from "#db/client.ts";
import {
  attendeesWithChangedAnswers,
  getBookedAnswers,
  saveBookedAnswers,
} from "#db/questions/attendee-answers/at-booking.ts";
import {
  type AttendeeAnswerSet,
  saveAttendeeAnswers,
} from "#db/questions/attendee-answers/save.ts";
import { deleteQuestion } from "#db/questions/delete.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A listing asking a choice question (Small or Large) and a free-text
 * question, with one attendee booked on it. */
const seedBooking = async () => {
  const listing = await createTestListing();
  const size = await createQuestion("Size?");
  const small = await addAnswer(size.id, 0, "Small");
  const large = await addAnswer(size.id, 1, "Large");
  const notes = await createQuestion("Notes?", { displayType: "free_text" });
  await listingQuestions.setIds(listing.id, [size.id, notes.id]);
  const attendee = await createAttendee(listing.id);
  const book = (answers: AttendeeAnswerSet) =>
    saveBookedAnswers(
      [{ attendee, listing }],
      new Map([[attendee.id, answers]]),
    );
  const edit = (answers: AttendeeAnswerSet) =>
    saveAttendeeAnswers(new Map([[attendee.id, answers]]));
  return { attendee, book, edit, large, listing, notes, size, small };
};

const recordRows = (attendeeId: number) =>
  queryAll<{ question_id: number; answer_id: number | null }>(
    `SELECT question_id, answer_id FROM answers_at_booking
     WHERE attendee_id = ? ORDER BY question_id`,
    [attendeeId],
  );

const bookedAnswers = (attendeeId: number) =>
  getBookedAnswers(attendeeId, getTestPrivateKey);

const recordedQuestionIds = async (attendeeId: number): Promise<number[]> =>
  (await recordRows(attendeeId)).map((row) => row.question_id);

/** A booking that picked Small, which an admin then changed to Large. */
const seedSmallChangedToLarge = async () => {
  const seeded = await seedBooking();
  await seeded.book({ answerIds: [seeded.small.id] });
  await seeded.edit({ answerIds: [seeded.large.id] });
  return seeded;
};

describeWithEnv("db > attendee answers > at booking", { db: true }, () => {
  test("records every question the listing asked, answered or blank", async () => {
    const { attendee, book, notes, size, small } = await seedBooking();
    await book({ answerIds: [small.id] });

    expect(await bookedAnswers(attendee.id)).toEqual([
      {
        answer: "Small",
        answerAtBooking: "Small",
        askedAs: "Size?",
        changed: false,
        changesPrice: false,
        question: "Size?",
        questionId: size.id,
      },
      {
        answer: null,
        answerAtBooking: null,
        askedAs: "Notes?",
        changed: false,
        changesPrice: false,
        question: "Notes?",
        questionId: notes.id,
      },
    ]);
  });

  test("records the questions of a booking that gave no answers", async () => {
    const { attendee, book, notes, size } = await seedBooking();
    await book({ answerIds: [] });

    expect(await recordRows(attendee.id)).toEqual([
      { answer_id: null, question_id: size.id },
      { answer_id: null, question_id: notes.id },
    ]);
  });

  test("records an assign-all question and skips one the listing does not ask", async () => {
    const { attendee, book, notes, size } = await seedBooking();
    const everyone = await createQuestion("Everyone?", {
      assignAll: true,
      displayType: "free_text",
    });
    await createQuestion("Elsewhere?", { displayType: "free_text" });
    await book({ answerIds: [] });

    expect(await recordedQuestionIds(attendee.id)).toEqual([
      size.id,
      notes.id,
      everyone.id,
    ]);
  });

  test("skips a choice question with no active answer, because the form hides it", async () => {
    const { attendee, book, listing, notes, size } = await seedBooking();
    const retired = await createQuestion("Retired?");
    await addAnswer(retired.id, 0, "Gone", { active: false });
    await listingQuestions.setIds(listing.id, [size.id, notes.id, retired.id]);
    await book({ answerIds: [] });

    expect(await recordedQuestionIds(attendee.id)).toEqual([size.id, notes.id]);
  });

  test("keeps the first record when the booking saves again", async () => {
    const { attendee, book, large, size, small } = await seedBooking();
    await book({ answerIds: [small.id] });
    await book({ answerIds: [large.id] });

    expect((await recordRows(attendee.id))[0]).toEqual({
      answer_id: small.id,
      question_id: size.id,
    });
  });

  test("an admin edit changes the answer but not the record", async () => {
    const { attendee } = await seedSmallChangedToLarge();

    const [row] = await bookedAnswers(attendee.id);
    expect(row).toMatchObject({
      answer: "Large",
      answerAtBooking: "Small",
      changed: true,
    });
    expect(await attendeesWithChangedAnswers([attendee.id])).toEqual(
      new Set([attendee.id]),
    );
  });

  test("an admin answer to a question left blank counts as changed", async () => {
    const { attendee, book, edit, notes } = await seedBooking();
    await book({ answerIds: [] });
    await edit({
      answerIds: [],
      textAnswers: [{ questionId: notes.id, text: "Late" }],
    });

    expect((await bookedAnswers(attendee.id))[1]).toMatchObject({
      answer: "Late",
      answerAtBooking: null,
      changed: true,
      questionId: notes.id,
    });
  });

  test("compares free text by its words, not by its stored copy", async () => {
    const { attendee, book, edit, notes } = await seedBooking();
    const typed = (text: string) => ({
      answerIds: [],
      textAnswers: [{ questionId: notes.id, text }],
    });
    await book(typed("Peanuts"));
    await edit(typed("Peanuts"));
    expect(await attendeesWithChangedAnswers([attendee.id])).toEqual(new Set());

    await edit(typed("Shellfish"));
    expect((await bookedAnswers(attendee.id))[1]).toMatchObject({
      answer: "Shellfish",
      answerAtBooking: "Peanuts",
      changed: true,
    });
  });

  test("an answer to a question the booking did not ask counts as changed", async () => {
    const { attendee, book, edit, small } = await seedBooking();
    const later = await createQuestion("Later?", { displayType: "free_text" });
    await book({ answerIds: [small.id] });
    await edit({
      answerIds: [small.id],
      textAnswers: [{ questionId: later.id, text: "Added" }],
    });

    expect((await bookedAnswers(attendee.id))[2]).toEqual({
      answer: "Added",
      answerAtBooking: null,
      askedAs: null,
      changed: true,
      changesPrice: false,
      question: "Later?",
      questionId: later.id,
    });
  });

  test("keeps the wording at booking when the operator edits it", async () => {
    const { attendee, book, size, small } = await seedBooking();
    await book({ answerIds: [small.id] });
    await questionsTable.update(size.id, {
      displayType: "radio",
      text: "Shirt size?",
    });
    await answersTable.update(small.id, { text: "S" });

    expect((await bookedAnswers(attendee.id))[0]).toMatchObject({
      answer: "S",
      answerAtBooking: "Small",
      askedAs: "Size?",
      changed: false,
      question: "Shirt size?",
    });
  });

  test("keeps a deleted question's row and does not count it as changed", async () => {
    const { attendee, book, notes, size, small } = await seedBooking();
    await book({ answerIds: [small.id] });
    await deleteQuestion(size.id);

    expect(await bookedAnswers(attendee.id)).toMatchObject([
      { questionId: notes.id },
      {
        answer: null,
        answerAtBooking: "Small",
        askedAs: "Size?",
        changed: false,
        question: null,
        questionId: size.id,
      },
    ]);
    expect(await attendeesWithChangedAnswers([attendee.id])).toEqual(new Set());
  });

  test("says a changed answer moves the price when either answer has a price modifier", async () => {
    const { attendee, small } = await seedSmallChangedToLarge();
    expect((await bookedAnswers(attendee.id))[0]?.changesPrice).toBe(false);

    await execute("UPDATE answers SET modifier_id = 1 WHERE id = ?", [
      small.id,
    ]);
    expect((await bookedAnswers(attendee.id))[0]?.changesPrice).toBe(true);
  });

  test("shows no record for a booking made before the record existed", async () => {
    const { attendee, edit, small } = await seedBooking();
    await edit({ answerIds: [small.id] });

    expect(await bookedAnswers(attendee.id)).toEqual([]);
    expect(await attendeesWithChangedAnswers([attendee.id])).toEqual(new Set());
  });

  test("reads the owner key only when there is free text to show", async () => {
    const { attendee, book, small } = await seedBooking();
    await book({ answerIds: [small.id] });
    let keyReads = 0;

    await getBookedAnswers(attendee.id, () => {
      keyReads++;
      return getTestPrivateKey();
    });
    expect(keyReads).toBe(0);
  });

  test("deletes the record with the attendee", async () => {
    const { attendee, book, small } = await seedBooking();
    await book({ answerIds: [small.id] });
    await deleteAttendee(attendee.id);

    expect(await recordRows(attendee.id)).toEqual([]);
  });
});
