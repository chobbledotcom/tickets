import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { execute, queryAll } from "#db/client.ts";
import {
  bookedAnswersTail,
  getBookedAnswers,
} from "#db/questions/attendee-answers/at-booking.ts";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import {
  type AttendeeAnswerSet,
  groupListingAnswerSets,
  prepareAttendeeAnswerSave,
  saveAttendeeAnswers,
} from "#db/questions/attendee-answers/save.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { deleteFrom } from "#db/write.ts";
import {
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import type { Attendee } from "#types";

const storedRows = (attendeeId: number) =>
  queryAll<{
    booking_row_id: number | null;
    listing_id: number | null;
    question_id: number;
    string_id: number;
  }>(
    sql`SELECT given.booking_row_id, line.listing_id,
            given.question_id, given.string_id
       FROM attendee_answers AS given
       LEFT JOIN listing_attendees AS line ON line.id = given.booking_row_id
      WHERE given.attendee_id = ${attendeeId}
      ORDER BY line.listing_id, given.question_id`,
  );

const usedCounts = async (): Promise<number[]> =>
  (
    await queryAll<{ used_count: number }>(
      sql`SELECT used_count FROM strings ORDER BY id`,
    )
  ).map((row) => row.used_count);

/** Save the given answers for one attendee. */
const saveFor = (
  attendeeId: number,
  answers: Omit<AttendeeAnswerSet, "answerIds">,
) =>
  saveAttendeeAnswers(new Map([[attendeeId, { answerIds: [], ...answers }]]));

/** One listing's own answer to a question. */
const lineAnswer = (listingId: number, questionId: number, text: string) => ({
  listingId,
  questionId,
  text,
});

const readLineAnswers = (attendeeId: number) =>
  getAttendeeLineAnswers(attendeeId, getTestPrivateKey);

const listingLevelQuestion = async () =>
  (await seedListingLevelQuestion()).question;

type SavedAnswers = Omit<AttendeeAnswerSet, "answerIds">;

/** Two discos booked by one attendee, with the answers `answers` names saved,
 * and what the database then holds. */
const savedOnTwoDiscos = async (
  answers: (ids: { a: number; b: number; q: number }) => SavedAnswers,
) => {
  const discoA = await createTestListing({ name: "Disco A" });
  const discoB = await createTestListing({ name: "Disco B" });
  const attendee = await bookTestAttendee([discoA.id, discoB.id], "Parent");
  const pupil = await listingLevelQuestion();
  const ids = { a: discoA.id, b: discoB.id, q: pupil.id };
  await saveFor(attendee.id, answers(ids));
  return {
    ...ids,
    attendeeId: attendee.id,
    read: () => readLineAnswers(attendee.id),
    rows: await storedRows(attendee.id),
  };
};

/** The child booked under a parent, and again through a package. */
const bookWithTwoPaths = async (
  parentId: number,
  childId: number,
): Promise<Attendee> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [
      { listingId: parentId },
      { listingId: childId, parentListingId: parentId },
      { listingId: childId, packageGroupId: 9 },
    ],
    email: "parent@test.com",
    name: "Parent",
  });
  if (!result.success) throw new Error(`Failed: ${result.reason}`);
  return result.attendees[0]!;
};

describeWithEnv("db > attendee answers > line answers", { db: true }, () => {
  test("files each listing's answer against that listing's booking row", async () => {
    const saved = await savedOnTwoDiscos(({ a, b, q }) => ({
      lineAnswers: [lineAnswer(a, q, "Ava"), lineAnswer(b, q, "Ben")],
    }));
    expect(saved.rows.map((row) => row.listing_id)).toEqual([saved.a, saved.b]);
    expect(await saved.read()).toEqual([
      lineAnswer(saved.a, saved.q, "Ava"),
      lineAnswer(saved.b, saved.q, "Ben"),
    ]);
  });

  test("keeps both listings' answers when two children share a name", async () => {
    const saved = await savedOnTwoDiscos(({ a, b, q }) => ({
      lineAnswers: [lineAnswer(a, q, "Sam"), lineAnswer(b, q, "Sam")],
    }));
    expect(new Set(saved.rows.map((row) => row.string_id)).size).toBe(1);
    expect(saved.rows).toHaveLength(2);
    expect(await usedCounts()).toEqual([2]);
  });

  test("keeps the last answer when one listing repeats a question", async () => {
    const saved = await savedOnTwoDiscos(({ a, q }) => ({
      lineAnswers: [lineAnswer(a, q, "First"), lineAnswer(a, q, "Last")],
    }));
    expect(await saved.read()).toEqual([lineAnswer(saved.a, saved.q, "Last")]);
  });

  test("files nothing for a listing the attendee did not book", async () => {
    const other = await createTestListing({ name: "Disco C" });
    const saved = await savedOnTwoDiscos(({ q }) => ({
      lineAnswers: [lineAnswer(other.id, q, "Cy")],
    }));
    expect(saved.rows).toEqual([]);
  });

  test("a booking-level save leaves the listing answers alone", async () => {
    const note = await createQuestion("Note", { displayType: "free_text" });
    const saved = await savedOnTwoDiscos(({ a, q }) => ({
      lineAnswers: [lineAnswer(a, q, "Ava")],
      textAnswers: [{ questionId: note.id, text: "First note" }],
    }));
    await saveFor(saved.attendeeId, {
      textAnswers: [{ questionId: note.id, text: "New" }],
    });
    const rows = await storedRows(saved.attendeeId);
    expect(rows.map((row) => [row.question_id, row.listing_id])).toEqual([
      [note.id, null],
      [saved.q, saved.a],
    ]);
  });

  test("takes the answers with the booking row", async () => {
    const saved = await savedOnTwoDiscos(({ a, b, q }) => ({
      lineAnswers: [lineAnswer(a, q, "Ava"), lineAnswer(b, q, "Ben")],
    }));
    await execute(
      deleteFrom(tables.listing_attendees).where({
        attendeeId: saved.attendeeId,
        listingId: saved.a,
      }),
    );
    expect(await saved.read()).toEqual([lineAnswer(saved.b, saved.q, "Ben")]);
    expect(await usedCounts()).toEqual([0, 1]);
  });

  test("files an answer against each booking row of the listing, under every path", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const attendee = await bookWithTwoPaths(parent.id, child.id);
    const pupil = await listingLevelQuestion();
    await saveFor(attendee.id, {
      lineAnswers: [lineAnswer(child.id, pupil.id, "Kit")],
    });
    const rows = await storedRows(attendee.id);
    expect(new Set(rows.map((row) => row.booking_row_id)).size).toBe(2);
    expect(await readLineAnswers(attendee.id)).toEqual([
      lineAnswer(child.id, pupil.id, "Kit"),
    ]);
  });

  test("a booking's answers ride its create batch and stay out of the booking record", async () => {
    const disco = await createTestListing({ name: "Disco A" });
    const pupil = await listingLevelQuestion();
    const attendee = await createAttendee(disco.id);
    const byListing = {
      [String(disco.id)]: [{ questionId: pupil.id, text: "Ava" }],
    };
    const prepared = await prepareAttendeeAnswerSave(
      groupListingAnswerSets(
        [{ attendee: { id: 0 }, listing: { id: disco.id } }],
        {},
        {},
        {},
        byListing,
      ),
    );
    for (const statement of bookedAnswersTail(prepared, [disco.id])(
      attendee.ticket_token_index,
    )) {
      await execute(statement);
    }
    expect(await readLineAnswers(attendee.id)).toEqual([
      lineAnswer(disco.id, pupil.id, "Ava"),
    ]);
    expect(await getBookedAnswers(attendee.id, getTestPrivateKey)).toEqual([]);
  });
});
