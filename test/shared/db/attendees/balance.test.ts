import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  postManualLedgerEntry,
} from "#shared/accounting/manual-entries.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import {
  attendeeStatuses,
  requirePaidDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
  settleAttendeeBalance,
} from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import { balanceFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import {
  createNonReservationAttendee,
  createReservedAttendee,
  settle,
} from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { historicalPaymentReferenceStorage } from "#test-utils/historical-payment-references.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { expectRefundReferences } from "#test-utils/payment-references.ts";
import {
  getProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

describeWithEnv("db > settle attendee balance", { db: true }, () => {
  test("clears the balance, moves to the paid status and logs it", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const paid = await requirePaidDefaultStatus();
    const settlement = settle();

    const result = await settleAttendeeBalance(attendeeId, 1500, settlement);
    expect(result).toEqual({ amount: 1500, listingId, settled: true });

    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
    expect(state?.statusId).toBe(paid.id);

    const log = await getAttendeeActivityLog(attendeeId);
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toContain("Reservation balance paid");

    const { rows } = await getDb().execute({
      args: [KIND.payment, String(attendeeId), 1500],
      sql: "SELECT event_group, reference FROM transfers WHERE kind = ? AND dest_id = ? AND amount = ?",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_group).toBe(
      await eventGroup(["balance", settlement.id]),
    );
    expect(rows[0]!.reference).toBe(
      await legReference(["balance", settlement.id, KIND.payment]),
    );
  });

  test("clears a non-reservation balance without replacing its status", async () => {
    const { attendeeId } = await createNonReservationAttendee(1500);
    const before = await getAttendeeBalanceState(attendeeId);

    const result = await settleAttendeeBalance(attendeeId, 1500, settle());
    expect(result.settled).toBe(true);

    const after = await getAttendeeBalanceState(attendeeId);
    expect(after?.remainingBalance).toBe(0);
    expect(after?.statusId).toBe(before?.statusId);
  });

  test("finalizes a balance session with its provider reference only when the amount still matches", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await reserveSession("balance-ref-ok");

    await settleAttendeeBalance(
      attendeeId,
      1500,
      settle("balance-ref-ok"),
      await balanceFinalizeStatements(
        "balance-ref-ok",
        attendeeId,
        1500,
        taggedPaymentReference("pi_balance_ok"),
      ),
    );

    const row = await getProcessedPayment("balance-ref-ok");
    expect(row?.attendee_id).toBe(attendeeId);
    expect(row?.payment_reference).not.toContain("pi_balance_ok");
    await expectRefundReferences(attendeeId, ["pi_balance_ok"]);
  });

  // The fault this closes: a refund run compares the attendee's whole set of
  // charges once and then works from that snapshot. A balance landing
  // underneath it is refunded by nobody, and the run reports success. The
  // callback must stand down and retry rather than write.
  test("refuses to finalize a balance while a refund run holds the attendee", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    // Their deposit charge, with a refund run holding it.
    await reserveSession("deposit-held");
    await getDb().execute(
      `UPDATE processed_payments SET attendee_id = ?, protected_state = 'claim'
        WHERE payment_session_id = ?`,
      [attendeeId, "deposit-held"],
    );
    await reserveSession("balance-held");

    await expect(
      settleAttendeeBalance(
        attendeeId,
        1500,
        settle("balance-held"),
        await balanceFinalizeStatements(
          "balance-held",
          attendeeId,
          1500,
          taggedPaymentReference("pi_balance_held"),
        ),
      ),
    ).rejects.toThrow();

    const row = await getProcessedPayment("balance-held");
    expect(row?.attendee_id).toBe(null);
    await expectRefundReferences(attendeeId, []);
  });

  test("refuses a tagged balance while another attendee holds its old raw identity", async () => {
    const holder = await createReservedAttendee(1);
    const target = await createReservedAttendee(1500);
    const reference = "pi_alias_held_elsewhere";
    const stored = await historicalPaymentReferenceStorage(reference);
    await reserveSession("legacy-alias-held");
    await getDb().execute({
      args: [
        holder.attendeeId,
        stored.encrypted,
        stored.index,
        "legacy-alias-held",
      ],
      sql: `UPDATE processed_payments
               SET attendee_id = ?, payment_reference = ?,
                   payment_reference_index = ?, protected_state = 'claim'
             WHERE payment_session_id = ?`,
    });
    await reserveSession("balance-alias-refused");

    await expect(
      settleAttendeeBalance(
        target.attendeeId,
        1500,
        settle("balance-alias-refused"),
        await balanceFinalizeStatements(
          "balance-alias-refused",
          target.attendeeId,
          1500,
          taggedPaymentReference(reference),
        ),
      ),
    ).rejects.toThrow();

    expect(
      (await getProcessedPayment("balance-alias-refused"))?.attendee_id,
    ).toBe(null);
  });

  test("does not finalize a balance session reference on amount mismatch", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await reserveSession("balance-ref-mismatch");

    const result = await settleAttendeeBalance(
      attendeeId,
      1000,
      settle("balance-ref-mismatch"),
      await balanceFinalizeStatements(
        "balance-ref-mismatch",
        attendeeId,
        1000,
        taggedPaymentReference("pi_balance_mismatch"),
      ),
    );

    expect(result).toEqual({ reason: "amount_mismatch", settled: false });
    const row = await getProcessedPayment("balance-ref-mismatch");
    expect(row?.attendee_id).toBe(null);
    expect(row?.payment_reference).toBe("");
  });

  test("is idempotent once the balance is cleared", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await settleAttendeeBalance(attendeeId, 1500, settle());
    expect(await settleAttendeeBalance(attendeeId, 1500, settle())).toEqual({
      reason: "nothing_owed",
      settled: false,
    });
  });

  test("settles a one-penny balance", async () => {
    const { attendeeId } = await createReservedAttendee(1);
    expect(await settleAttendeeBalance(attendeeId, 1, settle())).toMatchObject({
      amount: 1,
      settled: true,
    });
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      0,
    );
  });

  test("reports not_found for a missing attendee", async () => {
    expect(await settleAttendeeBalance(9999, 1500, settle())).toEqual({
      reason: "not_found",
      settled: false,
    });
  });

  test("refuses to settle when the live balance no longer matches what was paid", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    // The checkout was created for 1000, but the live balance is 1500 (e.g. the
    // owner raised it after checkout). Settling must be refused rather than
    // clearing the wrong 1500 for a 1000 payment.
    expect(await settleAttendeeBalance(attendeeId, 1000, settle())).toEqual({
      reason: "amount_mismatch",
      settled: false,
    });
    // The attendee is left untouched — balance intact, nothing folded in.
    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(1500);
  });

  test("settles exactly once when two callbacks race for the same amount", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    const [a, b] = await Promise.all([
      settleAttendeeBalance(attendeeId, 1500, settle()),
      settleAttendeeBalance(attendeeId, 1500, settle()),
    ]);
    // One settles; the other finds the balance already cleared.
    expect([a, b].filter((r) => r.settled)).toHaveLength(1);
    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
  });

  test("fails when no paid-default status is configured", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await getDb().execute("UPDATE attendee_statuses SET is_paid_default = 0");
    attendeeStatuses.invalidate();
    await expect(
      settleAttendeeBalance(attendeeId, 1500, settle()),
    ).rejects.toThrow(
      "No attendee status has the required is_paid_default flag",
    );
    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(1500);
  });

  test("settles an attendee that has no booking lines", async () => {
    await getDb().execute(
      "INSERT INTO attendees (created, pii_blob) VALUES ('2024-01-01T00:00:00Z', '')",
    );
    const { rows } = await getDb().execute(
      "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
    );
    const attendeeId = Number(rows[0]!.id);
    // Owe £9 in the ledger with no listing_attendees row: a sale to a listing
    // with no booking row, nothing paid. The settle clears it and, finding no
    // booking line, attributes no listing.
    await postListingSale({
      amountPaid: 0,
      attendeeId,
      gross: 900,
      listingId: 98765,
    });
    const result = await settleAttendeeBalance(attendeeId, 900, settle());
    // No bookings → the log entry has no listing attributed.
    expect(result).toEqual({ amount: 900, listingId: null, settled: true });
  });

  test("order summary is empty for an attendee with no bookings", async () => {
    await getDb().execute(
      "INSERT INTO attendees (created, pii_blob) VALUES ('2024-01-01T00:00:00Z', '')",
    );
    const { rows } = await getDb().execute(
      "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
    );
    const summary = await getAttendeeOrderSummary(Number(rows[0]!.id));
    expect(summary.lines).toHaveLength(0);
    expect(summary.fullPrice).toBe(0);
    expect(summary.totalQuantity).toBe(0);
    expect(summary.depositPaid).toBe(0);
  });

  test("order summary combines cash paid with the outstanding balance", async () => {
    const { attendeeId } = await createReservedAttendee(1500);

    const summary = await getAttendeeOrderSummary(attendeeId);

    expect(summary.depositPaid).toBe(100);
    expect(summary.fullPrice).toBe(1600);
  });

  test("order summary uses recorded payments when attendee state is missing", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com",
      unitPrice: 1000,
    });
    await getDb().execute({
      args: [listing.id, 999999],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, ?, 2)",
    });
    // price_paid projects from the ledger: post the 300 sale leg for this row.
    await postListingSale({
      attendeeId: 999999,
      gross: 300,
      listingId: listing.id,
    });

    const summary = await getAttendeeOrderSummary(999999);
    expect(summary.lines).toHaveLength(1);
    expect(summary.depositPaid).toBe(300);
    expect(summary.fullPrice).toBe(300);
    expect(summary.totalQuantity).toBe(2);
  });

  test("order summary preserves the original order price after a full refund", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(0);
    const reference = {
      index: `sale-${listingId}-${attendeeId}`,
      sessionIds: [`sale-${listingId}-${attendeeId}`],
    };
    const result = await recordAttendeeRefund(attendeeId, [reference]);

    expect(result).toEqual(refundLedgerResult([reference]));
    const summary = await getAttendeeOrderSummary(attendeeId);
    expect(summary.depositPaid).toBe(0);
    expect(summary.fullPrice).toBe(100);
  });

  test("order summary includes a later manual attendee charge", async () => {
    const { attendeeId } = await createReservedAttendee(0);
    await postManualLedgerEntry({
      account: attendeeAccount(attendeeId),
      amount: 1500,
      occurredAt: "2026-06-22T00:00:00.000Z",
      postedBy: "owner",
      type: MANUAL_ATTENDEE_CHARGE,
    });

    const summary = await getAttendeeOrderSummary(attendeeId);

    expect(summary.fullPrice).toBe(1600);
    expect(summary.depositPaid).toBe(100);
    expect(summary.reservationSubtotal).toBe(100);
  });

  test("order summary skips bookings whose listing no longer exists", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await getDb().execute({
      args: [attendeeId],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (98765, ?, 1)",
    });
    const summary = await getAttendeeOrderSummary(attendeeId);
    // Only the real listing is included; the dangling row is dropped.
    expect(summary.lines).toHaveLength(1);
  });

  test("order summary loads booking listings with one joined read", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const one = await runWithQueryLogContext(async () => {
      enableQueryLog();
      const summary = await getAttendeeOrderSummary(attendeeId);
      return { queryCount: getQueryLog().length, summary };
    });
    const otherListing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/other",
      unitPrice: 1200,
    });
    await getDb().execute({
      args: [otherListing.id, attendeeId],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, ?, 2)",
    });

    const multiple = await runWithQueryLogContext(async () => {
      enableQueryLog();
      const summary = await getAttendeeOrderSummary(attendeeId);
      return { queryCount: getQueryLog().length, summary };
    });

    expect(one.summary.lines.map((line) => line.listingId)).toEqual([
      listingId,
    ]);
    expect(multiple.summary.lines.map((line) => line.listingId)).toEqual([
      listingId,
      otherListing.id,
    ]);
    expect(one.queryCount).toBe(2);
    expect(multiple.queryCount).toBe(one.queryCount);
  });
});
