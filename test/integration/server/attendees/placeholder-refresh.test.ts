import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { queryOne } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { listProviderRefundCases } from "#shared/db/provider-refund-cases.ts";
import type { Attendee } from "#shared/types.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postPaymentLeg } from "#test-utils/db-helpers/payment-leg.ts";
import {
  protectedStateOf,
  putRowState,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  finalizeReservedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { withRefreshPaymentProbe } from "#test-utils/refund-routes.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Submit the refresh-payment route with a stubbed provider. */
const submitRefreshPayment = async (
  attendee: Attendee,
  refundedPredicate: (reference: string) => Promise<boolean>,
  // The expected flash message varies: "refunded" on first post, "up to date"
  // on retry. Accept any because expect.stringContaining returns a matcher.
  // deno-lint-ignore no-explicit-any
  expectedFlash: any = expect.stringContaining("refunded"),
): Promise<void> => {
  await withRefreshPaymentProbe(
    (reference: string) => refundedPredicate(reference),
    async () => {
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expectFlash(response, expectedFlash, true);
    },
  );
};

/** Create a quantity-0 placeholder attendee with a payment leg, finalize
 *  the payment reference, and optionally run a callback before the refresh. */
const setupPlaceholderForRefresh = async (
  name: string,
  email: string,
  sessionId: string,
  paymentReference: string,
  beforeRefresh?: (listingId: number) => Promise<void>,
): Promise<Attendee> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 800,
  });
  const created = await attendeesApi.createAttendeeAtomic({
    bookings: [
      { date: "2026-08-01", listingId: listing.id, pricePaid: 0, quantity: 0 },
    ],
    email,
    name,
    paymentId: paymentReference,
  });
  if (!created.success) throw new Error(`setup failed: ${created.reason}`);
  const attendee = created.attendees[0]!;
  await postPaymentLeg(attendee.id, 500, sessionId, listing.id, 0);
  await reserveSession(sessionId);
  await finalizeReservedPayment(
    sessionId,
    attendee.id,
    "tok-placeholder",
    taggedPaymentReference(paymentReference),
  );
  if (beforeRefresh) await beforeRefresh(listing.id);
  return attendee;
};

/** Submit the refresh with the provider reporting the refund as settled,
 *  and verify the refund_cash leg was posted to the attendee's account. */
const refreshAndVerifyRefundCash = async (
  attendee: Attendee,
): Promise<void> => {
  await submitRefreshPayment(attendee, () => Promise.resolve(true));
  const legs = await transfersByAccount(attendeeAccount(attendee.id));
  expect(legs.some((leg) => leg.kind === KIND.refundCash)).toBe(true);
};

describeWithEnv(
  "server (admin placeholder refresh payment)",
  { db: true },
  () => {
    describe("POST /admin/attendees/:attendeeId/refresh-payment (placeholder recovery)", () => {
      test("reconciles a quantity-0 placeholder when its refund later settles", async () => {
        const attendee = await setupPlaceholderForRefresh(
          "Placeholder",
          "placeholder@example.com",
          "placeholder-refresh-session",
          "pi_placeholder_refresh",
        );
        await refreshAndVerifyRefundCash(attendee);
      });

      test("a current payment refresh creates no refund work or delete blocker", async () => {
        const sessionId = "current-placeholder-session";
        const attendee = await setupPlaceholderForRefresh(
          "Current Placeholder",
          "current-placeholder@example.com",
          sessionId,
          "pi_current_placeholder",
        );

        await submitRefreshPayment(
          attendee,
          () => Promise.resolve(false),
          expect.stringContaining("up to date"),
        );

        expect(
          await queryOne<{ count: number }>(
            "SELECT COUNT(*) AS count FROM payment_charges",
          ),
        ).toEqual({ count: 0 });
        expect((await listProviderRefundCases()).cases).toEqual([]);
        expect(await protectedStateOf(sessionId)).toBe("");
        await expect(deleteAttendee(attendee.id)).resolves.toBeUndefined();
      });

      test("reconciles a placeholder whose listing was since deleted", async () => {
        const attendee = await setupPlaceholderForRefresh(
          "Deleted Placeholder",
          "deleted-listing@example.com",
          "placeholder-deleted-listing-session",
          "pi_placeholder_deleted",
          deleteListing,
        );
        await refreshAndVerifyRefundCash(attendee);
      });

      // The fault this closes: refresh found the money already back at the
      // provider and marked the charge, but a ledger post that did not land
      // left the row saying nothing at all. Delete then had nothing to refuse,
      // so the record of the refund — and the correction's target — could be
      // destroyed while the books still said the person had paid.
      test("marks the row when a found refund cannot be recorded", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 800,
        });
        const created = await attendeesApi.createAttendeeAtomic({
          bookings: [{ listingId: listing.id, pricePaid: 800, quantity: 1 }],
          email: "unrecorded@example.com",
          name: "Unrecorded",
          paymentId: "pi_unrecorded_refresh",
        });
        if (!created.success) {
          throw new Error(`setup failed: ${created.reason}`);
        }
        const attendee = created.attendees[0]!;
        await reserveSession("unrecorded-refresh-session");
        await finalizeReservedPayment(
          "unrecorded-refresh-session",
          attendee.id,
          "tok-unrecorded",
          taggedPaymentReference("pi_unrecorded_refresh"),
        );

        // The account carries no ledgered order, so the reversal has nothing
        // to mirror and the post cannot land.
        await withRefreshPaymentProbe(
          () => Promise.resolve(true),
          async () => {
            await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
          },
        );

        expect(await protectedStateOf("unrecorded-refresh-session")).toBe(
          UNRECORDED_MIRROR,
        );
      });

      // The fault this closes: the marker had no way off this path. A
      // placeholder has no ticket quantity, so the refund route that clears
      // one never picks it up — the row would have refused deletion for good,
      // long after the books had caught up.
      test("takes the mark off once the ledger catches up", async () => {
        const attendee = await setupPlaceholderForRefresh(
          "Caught Up",
          "caught-up@example.com",
          "caught-up-session",
          "pi_caught_up",
        );
        await putRowState(
          "caught-up-session",
          await rowStateSlot({ unrecorded: { returnedAt: "2026-08-01" } }),
          UNRECORDED_MIRROR,
        );

        await refreshAndVerifyRefundCash(attendee);

        expect(await protectedStateOf("caught-up-session")).toBe("");
      });
    });
  },
);
