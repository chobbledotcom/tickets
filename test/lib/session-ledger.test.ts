import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  type BookingLedgerDisposition,
  bookingLedgerDisposition,
  classifyBookingLedger,
} from "#shared/session-ledger.ts";
import {
  createPaidTestAttendee,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { tx } from "#test-utils/ledger.ts";

/**
 * The pure preflight decision table, pinning the classifier itself so the
 * booked/orphaned/unrecorded verdict can't drift. The IO loader ({@link
 * bookingLedgerDisposition}) gets its own DB-backed tests below.
 */
const cases: [boolean, number | null, BookingLedgerDisposition][] = [
  // No legs ⇒ never honoured, whatever the owner lookup would say.
  [false, null, { status: "unrecorded" }],
  [false, 42, { status: "unrecorded" }],
  // Legs with a live owner ⇒ a real booking to replay.
  [true, 42, { attendeeId: 42, status: "booked" }],
  // Legs but no live owner ⇒ deleted attendee / placeholder: already handled.
  [true, null, { status: "orphaned" }],
];

for (const [hasLegs, owner, expected] of cases) {
  test(`classifyBookingLedger(${hasLegs}, ${owner}) ⇒ ${expected.status}`, () => {
    expect(classifyBookingLedger(hasLegs, owner)).toEqual(expected);
  });
}

describeWithEnv("bookingLedgerDisposition", { db: true }, () => {
  test("returns unrecorded when the ledger holds no legs for the event", async () => {
    const disposition = await bookingLedgerDisposition("never-happened-event");
    expect(disposition).toEqual({ status: "unrecorded" });
  });

  test("skips the owner lookup for an unrecorded session, costing a single existence probe", async () => {
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      await bookingLedgerDisposition("never-happened-event-2");
      // Only eventGroupHasLegs' existence check — attendeeIdByLedgerEventGroup
      // must not run when there are no legs to own.
      expect(getQueryLog().length).toBe(1);
    });
  });

  test("returns orphaned when legs exist but no listing_attendees row owns the group", async () => {
    const eventId = "orphan-event";
    const group = await bookingEventGroup(eventId);
    await postTransfers([tx({ eventGroup: group, reference: "orphan-ref" })]);

    const disposition = await bookingLedgerDisposition(eventId);

    expect(disposition).toEqual({ status: "orphaned" });
  });

  test("returns booked with the owning attendee id when a live booking owns the group", async () => {
    const listing = await createTestListing();
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Test User",
      "test@example.com",
      "pay-1",
      500,
    );
    // Matches postListingSale's default eventId (`sale-${listingId}-${attendeeId}`),
    // used implicitly by createPaidTestAttendee.
    const eventId = `sale-${listing.id}-${attendee.id}`;

    const disposition = await bookingLedgerDisposition(eventId);

    expect(disposition).toEqual({ attendeeId: attendee.id, status: "booked" });
  });
});
