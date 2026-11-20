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
import type { Attendee } from "#types";

type StoredRow = {
  attendee_id: number;
  listing_attendee_id: number | null;
  listing_id: number | null;
  question_id: number;
  string_id: number;
};

const storedRows = (attendeeId: number) =>
  queryAll<StoredRow>(
    sql`SELECT given.attendee_id, given.listing_attendee_id, line.listing_id,
            given.question_id, given.string_id
       FROM attendee_answers AS given
       LEFT JOIN listing_attendees AS line ON line.id = given.listing_attendee_id
      WHERE given.attendee_id = ${attendeeId}
      ORDER BY line.listing_id, given.question_id`,
  );

const usedCounts = () =>
  queryAll<{ used_count: number }>(
    sql`SELECT used_count FROM strings ORDER BY id`,
  );

/** Two listings, one attendee booked on both, and a question that asks once
 * for each booked listing. */
const seedTwoDiscos = async () => {
  const discoA = await createTestListing({ name: "Disco A" });
  const discoB = await createTestListing({ name: "Disco B" });
  const attendee = await bookTestAttendee([discoA.id, discoB.id], "Parent");
  const pupil = await createQuestion("Pupil name", {
    answerLevel: "listing",
    displayType: "free_text",
  });
  return { attendee, discoA, discoB, pupil };
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
    const { attendee, discoA, discoB, pupil } = await seedTwoDiscos();
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: discoA.id, questionId: pupil.id, text: "Ava" },
              { listingId: discoB.id, questionId: pupil.id, text: "Ben" },
            ],
          },
        ],
      ]),
    );
    const rows = await storedRows(attendee.id);
    expect(rows.map((row) => row.listing_id)).toEqual([discoA.id, discoB.id]);
    expect(rows.every((row) => row.listing_attendee_id !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.string_id)).size).toBe(2);
    expect(
      await getAttendeeLineAnswers(attendee.id, getTestPrivateKey),
    ).toEqual([
      { listingId: discoA.id, questionId: pupil.id, text: "Ava" },
      { listingId: discoB.id, questionId: pupil.id, text: "Ben" },
    ]);
  });

  test("keeps two listings' answers when both children share a name", async () => {
    const { attendee, discoA, discoB, pupil } = await seedTwoDiscos();
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: discoA.id, questionId: pupil.id, text: "Sam" },
              { listingId: discoB.id, questionId: pupil.id, text: "Sam" },
            ],
          },
        ],
      ]),
    );
    const rows = await storedRows(attendee.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.string_id)).size).toBe(1);
    expect(await usedCounts()).toEqual([{ used_count: 2 }]);
  });

  test("keeps the last answer when one listing repeats a question", async () => {
    const { attendee, discoA, pupil } = await seedTwoDiscos();
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: discoA.id, questionId: pupil.id, text: "First" },
              { listingId: discoA.id, questionId: pupil.id, text: "Last" },
            ],
          },
        ],
      ]),
    );
    expect(
      await getAttendeeLineAnswers(attendee.id, getTestPrivateKey),
    ).toEqual([{ listingId: discoA.id, questionId: pupil.id, text: "Last" }]);
  });

  test("a booking-level save leaves the listing answers alone", async () => {
    const { attendee, discoA, pupil } = await seedTwoDiscos();
    const note = await createQuestion("Note", { displayType: "free_text" });
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: discoA.id, questionId: pupil.id, text: "Ava" },
            ],
            textAnswers: [{ questionId: note.id, text: "First note" }],
          },
        ],
      ]),
    );
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            textAnswers: [{ questionId: note.id, text: "New" }],
          },
        ],
      ]),
    );
    const rows = await storedRows(attendee.id);
    expect(rows.map((row) => [row.question_id, row.listing_id])).toEqual([
      [note.id, null],
      [pupil.id, discoA.id],
    ]);
  });

  test("files nothing for a listing the attendee did not book", async () => {
    const { attendee, pupil } = await seedTwoDiscos();
    const other = await createTestListing({ name: "Disco C" });
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: other.id, questionId: pupil.id, text: "Cy" },
            ],
          },
        ],
      ]),
    );
    expect(await storedRows(attendee.id)).toEqual([]);
  });

  test("files an answer against the booking row of the same listing under each path", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const attendee = await bookWithTwoPaths(parent.id, child.id);
    const pupil = await createQuestion("Pupil name", {
      answerLevel: "listing",
      displayType: "free_text",
    });
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: child.id, questionId: pupil.id, text: "Kit" },
            ],
          },
        ],
      ]),
    );
    const rows = await storedRows(attendee.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.listing_attendee_id)).size).toBe(2);
    expect(
      await getAttendeeLineAnswers(attendee.id, getTestPrivateKey),
    ).toEqual([{ listingId: child.id, questionId: pupil.id, text: "Kit" }]);
  });

  test("takes the answers with the booking row", async () => {
    const { attendee, discoA, discoB, pupil } = await seedTwoDiscos();
    await saveAttendeeAnswers(
      new Map([
        [
          attendee.id,
          {
            answerIds: [],
            lineTextAnswers: [
              { listingId: discoA.id, questionId: pupil.id, text: "Ava" },
              { listingId: discoB.id, questionId: pupil.id, text: "Ben" },
            ],
          },
        ],
      ]),
    );
    await execute(
      deleteFrom(tables.listing_attendees).where({
        attendeeId: attendee.id,
        listingId: discoA.id,
      }),
    );
    expect(
      await getAttendeeLineAnswers(attendee.id, getTestPrivateKey),
    ).toEqual([{ listingId: discoB.id, questionId: pupil.id, text: "Ben" }]);
    expect(await usedCounts()).toEqual([{ used_count: 0 }, { used_count: 1 }]);
  });

  test("a booking's answers ride its create batch and stay out of the booking record", async () => {
    const discoA = await createTestListing({ name: "Disco A" });
    const pupil = await createQuestion("Pupil name", {
      answerLevel: "listing",
      displayType: "free_text",
    });
    const attendee = await createAttendee(discoA.id);
    const prepared = await prepareAttendeeAnswerSave(
      groupListingAnswerSets(
        [{ attendee: { id: 0 }, listing: { id: discoA.id } }],
        {},
        {},
        {},
        {
          textAnswers: {
            [String(discoA.id)]: [{ questionId: pupil.id, text: "Ava" }],
          },
        },
      ),
    );
    for (const statement of bookedAnswersTail(prepared, [discoA.id])(
      attendee.ticket_token_index,
    )) {
      await execute(statement);
    }
    expect(
      await getAttendeeLineAnswers(attendee.id, getTestPrivateKey),
    ).toEqual([{ listingId: discoA.id, questionId: pupil.id, text: "Ava" }]);
    expect(await getBookedAnswers(attendee.id, getTestPrivateKey)).toEqual([]);
  });
});
