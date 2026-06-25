import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type BookingLedgerDisposition,
  classifyBookingLedger,
} from "#shared/session-ledger.ts";

/**
 * The pure preflight decision table. The IO loader ({@link bookingLedgerDisposition})
 * is exercised end-to-end by the webhook replay tests; here we pin the classifier
 * itself so the booked/orphaned/unrecorded verdict can't drift.
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
