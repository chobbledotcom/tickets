import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
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
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import {
  createNonReservationAttendee,
  createReservedAttendee,
  settle,
} from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { expectRefundReferences } from "#test-utils/payment-references.ts";

describeWithEnv("db > settle attendee balance", { db: true }, () => {
  test("clears the balance, moves to the paid status and logs it", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const paid = await requirePaidDefaultStatus();

    const result = await settleAttendeeBalance(attendeeId, 1500, settle());
    expect(result).toEqual({ amount: 1500, listingId, settled: true });

    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
    expect(state?.statusId).toBe(paid!.id);

    const log = await getAttendeeActivityLog(attendeeId);
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toContain("Reservation balance paid");
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
        "pi_balance_ok",
      ),
    );

    const row = await isSessionProcessed("balance-ref-ok");
    expect(row?.attendee_id).toBe(attendeeId);
    expect(row?.payment_reference).not.toContain("pi_balance_ok");
    await expectRefundReferences(attendeeId, ["pi_balance_ok"]);
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
        "pi_balance_mismatch",
      ),
    );

    expect(result).toEqual({ reason: "amount_mismatch", settled: false });
    const row = await isSessionProcessed("balance-ref-mismatch");
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
    expect(summary.listedFullPrice).toBe(2000);
    expect(summary.totalQuantity).toBe(2);
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
