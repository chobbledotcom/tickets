import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import {
  finalizeSession,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import type { Attendee } from "#shared/types.ts";
import {
  adminFormPost,
  createPaidAttendeeWithoutLedger,
  createTestListing,
  describeWithEnv,
  expectErrorFlash,
  expectFlash,
} from "#test-utils";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { refreshPaymentWithStripe } from "./server-attendees/helpers.ts";

const OCCURRED_AT = "2026-07-01T00:00:00.000Z";

const setupBalanceRefresh = async (
  balanceSessionId: string,
  balancePaymentId: string,
): Promise<Attendee> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    unitPrice: 800,
  });
  const attendee = await createPaidAttendeeWithoutLedger(
    listing.id,
    "John Doe",
    "john@example.com",
    "pi_refresh_deposit",
    500,
  );
  await postTransfers(
    await mapBooking({
      amountPaid: 500,
      attendeeId: attendee.id,
      bookingFee: 0,
      eventId: "refresh-deposit-session",
      lines: [{ gross: 800, listingId: listing.id }],
      modifiers: [],
      occurredAt: OCCURRED_AT,
    }),
  );
  await postTransfers([
    {
      amount: 300,
      destination: attendeeAccount(attendee.id),
      eventGroup: await balanceEventGroup(balanceSessionId),
      kind: KIND.payment,
      occurredAt: OCCURRED_AT,
      reference: "refresh-balance",
      source: WORLD,
    },
  ]);
  await reserveSession(balanceSessionId);
  await finalizeSession(balanceSessionId, attendee.id, [], balancePaymentId);
  return attendee;
};

/** Submits the refresh-payment route with a stubbed provider so each refund
 *  reference's provider status is whatever `refundedPredicate` returns.
 *  Returns the references the route actually asked the provider about, in
 *  call order, and asserts on the expected flash + success flag so a mutant
 *  that picks the wrong redirect or message is caught at the response. */
const submitRefreshPayment = async (
  attendee: Attendee,
  refundedPredicate: (reference: string) => Promise<boolean>,
  // deno-lint-ignore no-explicit-any
  expectedFlash: string | any = expect.stringContaining("refunded"),
  succeeded = true,
): Promise<string[]> => {
  const { response, queriedReferences } = await refreshPaymentWithStripe(
    attendee.id,
    refundedPredicate,
  );
  expectFlash(response, expectedFlash, succeeded);
  return queriedReferences;
};

describeWithEnv("server (admin attendee refresh payment)", { db: true }, () => {
  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    test("records provider-refunded deposit and balance charges", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-balance-session",
        "pi_refresh_balance",
      );

      const queried = await submitRefreshPayment(attendee, (reference) =>
        Promise.resolve(
          ["pi_refresh_balance", "pi_refresh_deposit"].includes(reference),
        ),
      );

      expect([...queried].sort()).toEqual([
        "pi_refresh_balance",
        "pi_refresh_deposit",
      ]);
    });

    test("reuses already-refunded balance charges before recording the refund", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-balance-already-refunded",
        "pi_refresh_balance_done",
      );
      await execute(
        `UPDATE processed_payments
            SET provider_refunded_at = ?
          WHERE payment_session_id = ?`,
        ["2026-07-01T00:01:00.000Z", "refresh-balance-already-refunded"],
      );

      const queried = await submitRefreshPayment(attendee, (reference) =>
        Promise.resolve(reference === "pi_refresh_deposit"),
      );

      expect(queried).toEqual(["pi_refresh_deposit"]);
    });

    test("returns 404 with an empty body for a non-existent attendee", async () => {
      const { response } = await adminFormPost(
        "/admin/attendees/9999999/refresh-payment",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    });

    test("reports no payment to refresh for an attendee without payment references", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const attendee = await bookTestAttendee(
        [listing.id],
        "No Refs",
        "no-refs@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expectErrorFlash(response, "No payment to refresh");
    });

    test("reports the status is current when a provider charge is not refunded", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 800,
      });
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Not Refunded",
        "not-refunded@example.com",
        "pi_not_refunded",
        500,
      );

      const queried = await submitRefreshPayment(
        attendee,
        () => Promise.resolve(false),
        expect.stringContaining("up to date"),
        true,
      );

      expect(queried).toEqual(["pi_not_refunded"]);
    });

    test("records a refund-not-recorded error when the ledger has no clean order to reverse", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 800,
      });
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Refunded No Ledger",
        "refunded-no-ledger@example.com",
        "pi_refunded_no_ledger",
        500,
      );

      await submitRefreshPayment(
        attendee,
        () => Promise.resolve(true),
        expect.stringContaining("could not be recorded"),
        false,
      );
    });
  });
});
