import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { withTransaction } from "#shared/db/client.ts";
import {
  readAttendeeRowStates,
  settleAttendeeRows,
} from "#shared/db/payment-claim.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";

const rowState = async (
  attendeeId: number,
  sessionId: string,
): Promise<PaymentRowState> =>
  await withTransaction(async (tx) => {
    const row = (await readAttendeeRowStates(tx, [attendeeId])).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (row === undefined) {
      throw new Error(`Payment row ${sessionId} was not found`);
    }
    return row.state;
  });

const claimAndReleaseUnrecorded = async (
  attendeeId: number,
  sessionId: string,
): Promise<void> => {
  const claim = await claimCurrentAttendeeRows([attendeeId], "keyless");
  if (claim.kind !== "claimed") throw new Error("The claim was refused");
  await settleAttendeeRows({
    heldSince: claim.heldSince,
    rows: new Map([[sessionId, { books: "unrecorded", claim: "release" }]]),
  });
};

describeWithEnv(
  "db > payment claim > unrecorded date",
  { db: true, encryptionKey: true },
  () => {
    test("a retry preserves when returned money was first found", async () => {
      using time = new FakeTime(new Date("2026-08-11T10:00:00.000Z"));
      const sessionId = "sess-returned-date";
      const attendeeId = await bookedWithPayment(sessionId, "pi_returned_date");

      await claimAndReleaseUnrecorded(attendeeId, sessionId);
      const first = (await rowState(attendeeId, sessionId)).unrecorded;
      if (first === undefined) throw new Error("The row was not marked");

      time.tick(60_000);
      await claimAndReleaseUnrecorded(attendeeId, sessionId);

      expect((await rowState(attendeeId, sessionId)).unrecorded).toEqual(first);
    });
  },
);
