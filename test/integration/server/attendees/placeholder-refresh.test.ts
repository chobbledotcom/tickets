import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { execute } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { Attendee } from "#shared/types.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postPaymentLeg } from "#test-utils/db-helpers/payment-leg.ts";
import { finalizeReservedPayment } from "#test-utils/processed-payments.ts";
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
    paymentReference,
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

      test("deletes the stale manual-refund note and adds a confirmation", async () => {
        const attendee = await setupPlaceholderForRefresh(
          "Stale Note",
          "stale-note@example.com",
          "placeholder-stale-note-session",
          "pi_stale_note",
        );
        const privateKey = await getTestPrivateKey();
        await createSystemNote(
          attendeeNotes(attendee.id),
          "This booking was kept at quantity 0 but its payment could NOT be refunded automatically because the event filled up while they were paying. Payment reference: pi_stale_note (code: capacity_full). Please refund it manually and check the [ledger](/admin/ledger/attendee/" +
            attendee.id +
            ").",
        );
        // A second system note about something else entirely. The cleanup is
        // for the stale manual-refund instruction only — it must not sweep
        // away the rest of the record's history.
        await createSystemNote(
          attendeeNotes(attendee.id),
          "Moved to another date at the guest's request.",
        );

        await submitRefreshPayment(attendee, () => Promise.resolve(true));

        const notes = await getNotesFor(attendeeNotes(attendee.id), privateKey);
        expect(
          notes.some((note) => note.note.includes("could NOT be refunded")),
        ).toBe(false);
        expect(
          notes.some((note) => note.note.includes("Moved to another date")),
        ).toBe(true);
        expect(
          notes.some((note) => note.note.includes("Refund confirmed")),
        ).toBe(true);
      });

      test("reconciles a placeholder whose listing was since deleted", async () => {
        const attendee = await setupPlaceholderForRefresh(
          "Deleted Placeholder",
          "deleted-listing@example.com",
          "placeholder-deleted-listing-session",
          "pi_placeholder_deleted",
          async (listingId) => {
            await execute("DELETE FROM listings WHERE id = ?", [listingId]);
          },
        );
        await refreshAndVerifyRefundCash(attendee);
      });

      test("cleans up a stale note on retry even when the ledger is already posted", async () => {
        // First refresh: posts the refund_cash leg + deletes the stale note.
        const attendee = await setupPlaceholderForRefresh(
          "Retry Cleanup",
          "retry@example.com",
          "placeholder-retry-session",
          "pi_placeholder_retry",
        );
        const privateKey = await getTestPrivateKey();
        // Simulate the initial refresh that posted the ledger but whose
        // note cleanup failed — re-create the stale note afterward.
        await refreshAndVerifyRefundCash(attendee);
        await createSystemNote(
          attendeeNotes(attendee.id),
          "This booking was kept at quantity 0 but its payment could NOT be refunded.",
        );

        // Second refresh: attendee.refunded is now true (the ledger has the
        // refund_cash leg), but the stale note must still be cleaned up.
        await submitRefreshPayment(
          attendee,
          () => Promise.resolve(true),
          expect.stringContaining("up to date"),
        );

        const notes = await getNotesFor(attendeeNotes(attendee.id), privateKey);
        expect(
          notes.some((note) => note.note.includes("could NOT be refunded")),
        ).toBe(false);
      });
    });
  },
);
