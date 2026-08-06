import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type BookingLedgerDisposition,
  classifyBookingLedger,
} from "#shared/session-ledger.ts";

const cases: [boolean, number | null, BookingLedgerDisposition][] = [
  [false, null, { status: "unrecorded" }],
  [false, 42, { status: "unrecorded" }],
  [true, 42, { attendeeId: 42, status: "booked" }],
  [true, null, { status: "orphaned" }],
];

for (const [hasLegs, owner, expected] of cases) {
  test(`classifyBookingLedger(${hasLegs}, ${owner}) => ${expected.status}`, () => {
    expect(classifyBookingLedger(hasLegs, owner)).toEqual(expected);
  });
}
