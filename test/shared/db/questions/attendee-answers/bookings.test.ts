/**
 * The bookings that answered a question: one row per booking, newest booking
 * first, carrying the answer that booking gave and the listings it holds.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getQuestionBookings } from "#db/questions/attendee-answers/bookings.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { sql } from "#db/sql.ts";
import { seedChoiceAndTextQuestions } from "#test/shared/db/questions/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { dropAttendeeBookings } from "#test-utils/db-helpers/booking-shapes.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A booking on the given listings, recorded at the given time so the read's
 *  order is the one the test asked for and not the clock's. */
const seedBookingAt = async (
  listingIds: number[],
  created: string,
): Promise<number> => {
  const attendee = await bookTestAttendee(listingIds);
  await execute(
    sql`UPDATE attendees SET created = ${created} WHERE id = ${attendee.id}`,
  );
  return attendee.id;
};

const bookAnswers = (attendeeId: number, answerIds: number[]): Promise<void> =>
  saveAttendeeAnswers(new Map([[attendeeId, { answerIds }]]));

describeWithEnv("db > question bookings", { db: true }, () => {
  test("names the answer a choice booking gave and the listings it holds", async () => {
    const { listing, size, small } = await seedChoiceAndTextQuestions();
    const attendeeId = await seedBookingAt(
      [listing.id],
      "2026-06-01T09:00:00.000Z",
    );
    await bookAnswers(attendeeId, [small.id]);

    expect(
      await getQuestionBookings(size.id, await getTestPrivateKey()),
    ).toEqual([
      {
        answer_id: small.id,
        answer_text: "Small",
        attendee_id: attendeeId,
        created: "2026-06-01T09:00:00.000Z",
        free_text: null,
        listing_ids: [listing.id],
        question_id: size.id,
      },
    ]);
  });

  test("decrypts the words a free-text booking typed", async () => {
    const { listing, notes } = await seedChoiceAndTextQuestions();
    const attendeeId = await seedBookingAt(
      [listing.id],
      "2026-06-02T09:00:00.000Z",
    );
    await saveAttendeeAnswers(
      new Map([
        [
          attendeeId,
          {
            answerIds: [],
            textAnswers: [{ questionId: notes.id, text: "Hay" }],
          },
        ],
      ]),
    );

    expect(
      await getQuestionBookings(notes.id, await getTestPrivateKey()),
    ).toEqual([
      {
        answer_id: null,
        answer_text: null,
        attendee_id: attendeeId,
        created: "2026-06-02T09:00:00.000Z",
        free_text: "Hay",
        listing_ids: [listing.id],
        question_id: notes.id,
      },
    ]);
  });

  test("answers the newest booking first", async () => {
    const { listing, size, small } = await seedChoiceAndTextQuestions();
    const older = await seedBookingAt([listing.id], "2026-06-01T09:00:00.000Z");
    const newer = await seedBookingAt([listing.id], "2026-06-03T09:00:00.000Z");
    await bookAnswers(older, [small.id]);
    await bookAnswers(newer, [small.id]);

    const rows = await getQuestionBookings(size.id, await getTestPrivateKey());
    expect(rows.map((row) => row.attendee_id)).toEqual([newer, older]);
  });

  test("names every listing in ascending order whatever order the lines came in", async () => {
    const { listing, size, small } = await seedChoiceAndTextQuestions();
    const other = await createTestListing();
    const attendeeId = await seedBookingAt(
      [Math.max(listing.id, other.id), Math.min(listing.id, other.id)],
      "2026-06-04T09:00:00.000Z",
    );
    await bookAnswers(attendeeId, [small.id]);

    const [row] = await getQuestionBookings(size.id, await getTestPrivateKey());
    expect(row!.listing_ids).toEqual(
      [listing.id, other.id].sort((left, right) => left - right),
    );
  });

  test("answers no listing ids for a booking with no line", async () => {
    const { listing, size, small } = await seedChoiceAndTextQuestions();
    const attendeeId = await seedBookingAt(
      [listing.id],
      "2026-06-05T09:00:00.000Z",
    );
    await bookAnswers(attendeeId, [small.id]);
    await dropAttendeeBookings(attendeeId);

    const [row] = await getQuestionBookings(size.id, await getTestPrivateKey());
    expect(row!.listing_ids).toEqual([]);
  });

  test("answers no bookings for a question nobody answered", async () => {
    const { size } = await seedChoiceAndTextQuestions();
    expect(
      await getQuestionBookings(size.id, await getTestPrivateKey()),
    ).toEqual([]);
  });
});
