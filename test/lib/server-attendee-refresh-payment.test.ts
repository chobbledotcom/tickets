import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
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
import { paymentsApi } from "#shared/payments.ts";
import type { Attendee } from "#shared/types.ts";
import {
  adminFormPost,
  createPaidAttendeeWithoutLedger,
  createTestListing,
  describeWithEnv,
  expectFlash,
  mockProviderType,
  withMocks,
} from "#test-utils";

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
 *  call order, so a test asserts on which charges were checked. */
const submitRefreshPayment = async (
  attendee: Attendee,
  refundedPredicate: (reference: string) => Promise<boolean>,
): Promise<string[]> => {
  const providerQueries: string[] = [];
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockRefunded = stub(
        stripePaymentProvider,
        "isPaymentRefunded",
        (reference: string) => {
          providerQueries.push(reference);
          return refundedPredicate(reference);
        },
      );
      try {
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/refresh-payment`,
        );
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("refunded"));
      } finally {
        mockRefunded.restore();
      }
    },
  );
  return providerQueries;
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
  });
});
