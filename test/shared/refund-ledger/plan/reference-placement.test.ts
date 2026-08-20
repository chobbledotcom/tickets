import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#accounting/accounts.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  legacyReference,
  postBooking,
  refundCashAmounts,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

describeWithEnv("refund ledger > reference placement", { db: true }, () => {
  test("posts the second charge's reversal when it comes back later", async () => {
    const attendeeId = 41;
    await postBooking({ attendeeId, eventId: "sess-first" });
    await postBooking({ attendeeId, eventId: "sess-second" });

    await recordAttendeeRefund(attendeeId, [sessionReference("sess-first")]);
    expect(await refundCashAmounts(attendeeId)).toEqual([5000]);

    const references = [
      sessionReference("sess-first"),
      sessionReference("sess-second"),
    ];
    expect(await recordAttendeeRefund(attendeeId, references)).toEqual(
      refundLedgerResult(references),
    );
    expect(await refundCashAmounts(attendeeId)).toEqual([5000, 5000]);
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
  });

  test("replaying one returned charge keeps its existing reversal recorded", async () => {
    const attendeeId = 51;
    await postBooking({ attendeeId, eventId: "sess-back" });
    await postBooking({ attendeeId, eventId: "sess-stuck" });
    const returned = [sessionReference("sess-back")];
    await recordAttendeeRefund(attendeeId, returned);
    const transferCount = (await allTransfers()).length;

    expect(await recordAttendeeRefund(attendeeId, returned)).toEqual(
      refundLedgerResult(returned),
    );
    expect((await allTransfers()).length).toBe(transferCount);
    expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
  });

  test("reports a named return that has no ledger group", async () => {
    const attendeeId = 52;
    await postBooking({ attendeeId, eventId: "sess-placed" });

    const placed = sessionReference("sess-placed");
    const missing = sessionReference("sess-missing");
    expect(await recordAttendeeRefund(attendeeId, [placed, missing])).toEqual(
      refundLedgerResult([placed], [missing]),
    );
    expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
  });

  test("does not place two legacy returns on one unmatched payment group", async () => {
    const attendeeId = 53;
    await postBooking({ attendeeId, eventId: "sess-named" });
    await postBooking({ attendeeId, eventId: "sess-one-legacy" });

    const named = sessionReference("sess-named");
    const legacyOne = legacyReference("pi-legacy-one");
    const legacyTwo = legacyReference("pi-legacy-two");
    expect(
      await recordAttendeeRefund(attendeeId, [named, legacyOne, legacyTwo]),
    ).toEqual(refundLedgerResult([named], [legacyOne, legacyTwo]));
    expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
  });

  test("reports an unplaceable legacy return as not recorded", async () => {
    const attendeeId = 61;
    await postBooking({ attendeeId, eventId: "sess-a" });
    await postBooking({ attendeeId, eventId: "sess-b" });
    await postBooking({ attendeeId, eventId: "sess-c" });

    const tracked = sessionReference("sess-a");
    const legacy = legacyReference("pi-legacy");
    const posted = await recordAttendeeRefund(attendeeId, [tracked, legacy]);

    expect(posted).toEqual(refundLedgerResult([tracked], [legacy]));
    expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
  });
});
