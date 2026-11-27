import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildAttendeeEditBatch,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { attendeePiiWriteStatements } from "#db/attendees/pii-write.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { execute, executeBatchWithResults, queryOne } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { CANCELLABLE_STATUSES } from "#payment/subscription-machine-spec.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import {
  bookingChoice,
  createAttendee,
  createFreeTextQuestion,
  runMerge,
  saveLineAnswer,
} from "#test/shared/merge/attendee-merge/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { givePlan, MONTHLY } from "#test-utils/db-helpers/subscriptions.ts";
import { addLine, setupMulti, twoListings } from "./helpers.ts";

/** An attendee with the given bookings, holding the edit a person prepared
 * before any race landed: rewrite the PII, and swap every booking for one line
 * on a fresh listing. */
const attendeeWithStaleEdit = async (
  bookings: Parameters<typeof setupMulti>[0],
  removedLineAnswers: "refuse" | "delete" = "refuse",
) => {
  const { attendee, blob, existing } = await setupMulti(
    bookings,
    { email: "before@example.com", name: "Alice" },
    { email: "after@example.com", name: "Edited" },
  );
  const replacement = await createTestListing({ maxAttendees: 10 });
  const statements = [
    ...(await attendeePiiWriteStatements(attendee.id, blob)),
    ...buildAttendeeEditBatch(
      attendee.id,
      [addLine(replacement.id)],
      new Map(existing.map(({ key, booking }) => [key, booking])),
      { allowOverbook: false, removedLineAnswers },
    ),
  ];
  return { attendee, existing, replacement, statements };
};

describeWithEnv(
  "db > attendees > subscription edit races",
  { db: true },
  () => {
    for (const status of CANCELLABLE_STATUSES) {
      test(`rolls back the whole stale edit after a merge copies a subscription with status ${status}`, async () => {
        const { listing1: ordinary, listing2: subscribed } =
          await twoListings();
        const {
          attendee: target,
          existing,
          replacement,
          statements,
        } = await attendeeWithStaleEdit([
          { listingId: ordinary.id, quantity: 1 },
          { listingId: subscribed.id, quantity: 1 },
        ]);
        const source = await createAttendee(subscribed.id, "Bob");
        await givePlan(source.id, "sub_edit_race", { ...MONTHLY, status });
        expect(
          existing.map(({ booking }) => booking.subscription_status),
        ).toEqual(["", ""]);
        expect(existing.map(({ booking }) => booking.listing_id)).toEqual([
          ordinary.id,
          subscribed.id,
        ]);

        const { result } = await runMerge({
          decide: bookingChoice(
            bookingKey(subscribed.id, null, 0, 0),
            "take_source",
          ),
          source,
          target,
        });
        expect(result.success).toBe(true);
        const beforeEdit = await loadExistingLines(target.id);
        expect(
          beforeEdit.map(({ booking }) => ({
            listingId: booking.listing_id,
            subscriptionId: booking.subscription_id,
            subscriptionStatus: booking.subscription_status,
          })),
        ).toEqual([
          {
            listingId: ordinary.id,
            subscriptionId: "",
            subscriptionStatus: "",
          },
          {
            listingId: subscribed.id,
            subscriptionId: "sub_edit_race",
            subscriptionStatus: status,
          },
        ]);
        expect(beforeEdit[1]!.booking).toMatchObject({
          recurring_interval: MONTHLY.interval,
          recurring_price: MONTHLY.price,
          recurring_tax: MONTHLY.tax,
        });
        expect(await loadExistingLines(source.id)).toEqual([]);
        const beforePii = await queryOne(
          sql`SELECT pii_blob FROM attendees WHERE id = ${target.id}`,
        );

        await expect(executeBatchWithResults(statements)).rejects.toThrow();

        expect(await loadExistingLines(target.id)).toEqual(beforeEdit);
        expect(
          await queryOne(
            sql`SELECT pii_blob FROM attendees WHERE id = ${target.id}`,
          ),
        ).toEqual(beforePii);
        expect(
          await getAttendeeOrNull(target.id, await getTestPrivateKey()),
        ).toMatchObject({ email: "before@example.com", name: "Alice" });
        expect(
          await queryOne(
            sql`SELECT attendee_id FROM listing_attendees WHERE listing_id = ${replacement.id}`,
          ),
        ).toBeNull();
      });
    }

    test("keeps an already removed ordinary line a no-op in a stale edit", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee, replacement, statements } = await attendeeWithStaleEdit(
        [{ listingId: listing.id, quantity: 1 }],
      );
      await execute(
        sql`DELETE FROM listing_attendees WHERE attendee_id = ${attendee.id} AND listing_id = ${listing.id}`,
      );

      await executeBatchWithResults(statements);

      expect(
        (await loadExistingLines(attendee.id)).map(({ booking }) => ({
          listingId: booking.listing_id,
          quantity: booking.quantity,
          subscriptionId: booking.subscription_id,
        })),
      ).toEqual([
        { listingId: replacement.id, quantity: 1, subscriptionId: "" },
      ]);
      expect(
        await getAttendeeOrNull(attendee.id, await getTestPrivateKey()),
      ).toMatchObject({ email: "after@example.com", name: "Edited" });
    });

    /** A stale edit that removes a line, after the line gained an answer. */
    const answeredStaleEdit = async (
      removedLineAnswers: "refuse" | "delete",
    ) => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const edit = await attendeeWithStaleEdit(
        [{ listingId: listing.id, quantity: 1 }],
        removedLineAnswers,
      );
      const question = await createFreeTextQuestion();
      await saveLineAnswer(edit.attendee.id, listing.id, question.id, "Ava");
      return edit;
    };

    test("rolls back a stale edit that removes a line which gained an answer", async () => {
      const { attendee, existing, statements } =
        await answeredStaleEdit("refuse");

      await expect(executeBatchWithResults(statements)).rejects.toThrow();

      expect(await loadExistingLines(attendee.id)).toEqual(existing);
    });

    test("a stale edit that may delete answers removes the line and its answer", async () => {
      const { attendee, replacement, statements } =
        await answeredStaleEdit("delete");

      await executeBatchWithResults(statements);

      expect(
        (await loadExistingLines(attendee.id)).map(
          ({ booking }) => booking.listing_id,
        ),
      ).toEqual([replacement.id]);
      expect(
        await queryOne(
          sql`SELECT id FROM attendee_answers WHERE attendee_id = ${attendee.id}`,
        ),
      ).toBeNull();
    });
  },
);
