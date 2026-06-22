import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import {
  attendeeStatusesTable,
  getPaidDefaultStatus,
  invalidateAttendeeStatusesCache,
} from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
  settleAttendeeBalance,
} from "#shared/db/attendees/balance.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

/** Create a reserved attendee with an outstanding balance. */
const createReservedAttendee = async (remainingBalance: number) => {
  const listing = await createTestListing({
    maxAttendees: 10,
    thankYouUrl: "https://example.com",
  });
  const reservation = await attendeeStatusesTable.insert({
    isReservation: true,
    name: "Reserved",
    reservationAmount: "10%",
  });
  const result = await createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 100, quantity: 1 }],
    email: "guest@example.com",
    name: "Guest",
    remainingBalance,
    statusId: reservation.id,
  });
  if (!result.success) throw new Error("setup failed");
  return { attendeeId: result.attendees[0]!.id, listingId: listing.id };
};

describeWithEnv("db > settle attendee balance", { db: true }, () => {
  test("clears the balance, moves to the paid status and logs it", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const paid = await getPaidDefaultStatus();

    const result = await settleAttendeeBalance(attendeeId, 1500);
    expect(result).toEqual({ amount: 1500, listingId, settled: true });

    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
    expect(state?.statusId).toBe(paid!.id);

    const log = await getAttendeeActivityLog(attendeeId);
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toContain("Reservation balance paid");
  });

  test("is idempotent once the balance is cleared", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await settleAttendeeBalance(attendeeId, 1500);
    expect(await settleAttendeeBalance(attendeeId, 1500)).toEqual({
      reason: "nothing_owed",
      settled: false,
    });
  });

  test("reports not_found for a missing attendee", async () => {
    expect(await settleAttendeeBalance(9999, 1500)).toEqual({
      reason: "not_found",
      settled: false,
    });
  });

  test("refuses to settle when the live balance no longer matches what was paid", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    // The checkout was created for 1000, but the live balance is 1500 (e.g. the
    // owner raised it after checkout). Settling must be refused rather than
    // clearing the wrong 1500 for a 1000 payment.
    expect(await settleAttendeeBalance(attendeeId, 1000)).toEqual({
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
      settleAttendeeBalance(attendeeId, 1500),
      settleAttendeeBalance(attendeeId, 1500),
    ]);
    // One settles; the other finds the balance already cleared.
    expect([a, b].filter((r) => r.settled)).toHaveLength(1);
    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
  });

  test("settles even when no paid-default status is configured", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await getDb().execute("UPDATE attendee_statuses SET is_paid_default = 0");
    invalidateAttendeeStatusesCache();
    const result = await settleAttendeeBalance(attendeeId, 1500);
    expect(result.settled).toBe(true);
    // No paid default: COALESCE keeps the existing status.
    const state = await getAttendeeBalanceState(attendeeId);
    expect(state?.remainingBalance).toBe(0);
  });

  test("settles an attendee that has no booking lines", async () => {
    await getDb().execute(
      "INSERT INTO attendees (created, pii_blob, remaining_balance) VALUES ('2024-01-01T00:00:00Z', '', 900)",
    );
    const { rows } = await getDb().execute(
      "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
    );
    const attendeeId = Number(rows[0]!.id);
    const result = await settleAttendeeBalance(attendeeId, 900);
    // No bookings → the log entry has no listing attributed.
    expect(result).toEqual({ amount: 900, listingId: null, settled: true });
  });

  test("order summary is empty for an attendee with no bookings", async () => {
    await getDb().execute(
      "INSERT INTO attendees (created, pii_blob, remaining_balance) VALUES ('2024-01-01T00:00:00Z', '', 0)",
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
    const otherListing = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/other",
      unitPrice: 1200,
    });
    await getDb().execute({
      args: [otherListing.id, attendeeId],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, ?, 2)",
    });

    const { entries, summary } = await runWithQueryLogContext(async () => {
      enableQueryLog();
      const summary = await getAttendeeOrderSummary(attendeeId);
      return { entries: getQueryLog(), summary };
    });

    expect(summary.lines.map((line) => line.listingId)).toEqual([
      listingId,
      otherListing.id,
    ]);
    expect(
      entries.filter((entry) =>
        entry.sql.includes("FROM listing_attendees AS listingAttendee"),
      ),
    ).toHaveLength(1);
    expect(
      entries.filter(
        (entry) =>
          entry.sql.includes("FROM listings AS listing") &&
          !entry.sql.includes("JOIN listings"),
      ),
    ).toHaveLength(0);
  });
});
