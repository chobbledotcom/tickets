/** Attendee Actions-tab links and the payment states that make them safe. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
  staleClaimSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { addProviderRefundTestCase } from "#test-utils/provider-refund-cases.ts";
import { withTestSession } from "#test-utils/session.ts";
import { bookAttendee, MANAGER, OWNER, tabHtml } from "./helpers.ts";

/** One paid attendee whose modern payment row can carry review work. */
const paidPagePayment = async (
  suffix: string,
  provider: PaymentProviderType = "stripe",
): Promise<{ attendeeId: number; listingId: number; sessionId: string }> => {
  const listing = await createTestListing({});
  const paymentId = `pi_page_${suffix}`;
  const attendee = await createPaidTestAttendee(
    listing.id,
    "Paid Person",
    "paid@example.com",
    paymentId,
  );
  const sessionId = `sess-page-${suffix}`;
  await finalizeProcessedPayment(
    sessionId,
    attendee.id,
    `tok-page-${suffix}`,
    taggedPaymentReference(paymentId, provider),
  );
  return { attendeeId: attendee.id, listingId: listing.id, sessionId };
};

describeWithEnv("the attendee Actions tab", { db: true }, () => {
  describe("ordinary actions", () => {
    test("sends the reader back to the tab they came from", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      // The return URL is threaded through as a query value, so the confirm
      // page can come back to this exact tab.
      expect(html).toContain(
        `/admin/attendees/${id}/resend-notification?return_url=${encodeURIComponent(
          `/admin/attendees/${id}/actions`,
        )}`,
      );
    });

    test("links a text message to this attendee on this listing", async () => {
      const listing = await createTestListing({});
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace Hopper",
        "grace@example.com",
      );
      const html = await tabHtml(attendee.id, "actions");
      // The separator is escaped in the rendered attribute.
      expect(html).toContain(
        `/admin/sms?listing=${listing.id}&amp;attendee=${attendee.id}`,
      );
    });

    test("offers deleting without a return URL, since there is nothing to come back to", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      expect(html).toContain(`/admin/attendees/${id}/delete"`);
    });

    test("still offers managers an ordinary attendee delete they may perform", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions", MANAGER);
      expect(html).toContain(`/admin/attendees/${id}/delete"`);
    });

    test("does not offer a refund for an attendee who never paid", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      expect(html).not.toContain(`/admin/attendees/${id}/refund`);
    });

    test("marks deleting as the dangerous action it is", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      const deleteLink = html.slice(
        0,
        html.indexOf(`/admin/attendees/${id}/delete`),
      );
      expect(deleteLink.slice(-120)).toContain("danger");
    });
  });

  describe("refund safety", () => {
    test("offers a refund for an attendee who paid", async () => {
      const { attendeeId } = await paidPagePayment("refund");
      const html = await tabHtml(attendeeId, "actions");
      expect(html).toContain(`/admin/attendees/${attendeeId}/refund`);
      // Named, not just linked — the label is what the operator reads.
      expect(html).toContain("Refund");
    });

    test("shows only owners the review action instead of refund", async () => {
      const { attendeeId, sessionId } = await paidPagePayment("review");
      await putRowState(
        sessionId,
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        REVIEW_MIRROR,
      );

      const ownerHtml = await tabHtml(attendeeId, "actions");
      expect(ownerHtml).toContain(
        `/admin/attendees/${attendeeId}/payment-review`,
      );
      expect(ownerHtml).toContain("Mark payment reviewed");
      expect(ownerHtml).not.toContain(`/admin/attendees/${attendeeId}/refund`);
      expect(ownerHtml).not.toContain(`/admin/attendees/${attendeeId}/delete`);

      const managerHtml = await tabHtml(attendeeId, "actions", MANAGER);
      expect(managerHtml).not.toContain("payment-review");
      expect(managerHtml).not.toContain("Mark payment reviewed");
      expect(managerHtml).not.toContain(
        `/admin/attendees/${attendeeId}/delete`,
      );
    });

    test("keeps attendee work reachable after the final listing is deleted", async () => {
      const { attendeeId, listingId, sessionId } =
        await paidPagePayment("orphan-review");
      await putRowState(
        sessionId,
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        REVIEW_MIRROR,
      );
      await deleteListing(listingId);

      const html = await tabHtml(attendeeId, "actions");
      expect(html).toContain(`/admin/attendees/${attendeeId}/payment-review`);
      expect(html).not.toContain(`/admin/attendees/${attendeeId}/delete`);
      expect(html).not.toContain(`/admin/attendees/${attendeeId}/refund`);
      expect(html).not.toContain(
        `/admin/attendees/${attendeeId}/resend-notification`,
      );
      expect(html).not.toContain("/admin/sms?listing=");
    });

    test("offers no refund while Money still has to record a returned payment", async () => {
      const { attendeeId, sessionId } = await paidPagePayment("unrecorded");
      await putRowState(
        sessionId,
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-08-12T10:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );

      const html = await tabHtml(attendeeId, "actions");
      expect(html).not.toContain(`/admin/attendees/${attendeeId}/refund`);
      expect(html).not.toContain(
        `/admin/attendees/${attendeeId}/payment-review`,
      );
      expect(html).not.toContain(`/admin/attendees/${attendeeId}/delete`);
    });

    test("offers only owners the canonical provider recovery queue", async () => {
      const paymentId = "pi_page_provider-recovery";
      const { attendeeId } = await paidPagePayment(
        "provider-recovery",
        "sumup",
      );
      await addProviderRefundTestCase(paymentId);

      const ownerHtml = await tabHtml(attendeeId, "actions");
      expect(ownerHtml).toContain('href="/admin/privacy#refund-recovery"');
      expect(ownerHtml).toContain("Open Refund recovery");
      expect(ownerHtml).not.toContain(`/admin/attendees/${attendeeId}/refund`);
      expect(ownerHtml).not.toContain(
        `/admin/attendees/${attendeeId}/payment-review`,
      );
      expect(ownerHtml).not.toContain(`/admin/attendees/${attendeeId}/delete`);

      const managerHtml = await tabHtml(attendeeId, "actions", MANAGER);
      expect(managerHtml).not.toContain("/admin/privacy#refund-recovery");
      expect(managerHtml).not.toContain("Open Refund recovery");
      expect(managerHtml).not.toContain(
        `/admin/attendees/${attendeeId}/delete`,
      );
    });

    test("maps ordinary, stale, and in-progress rows to safe actions", async () => {
      const { attendeeId, sessionId } = await paidPagePayment("states");
      const refundUrl = `/admin/attendees/${attendeeId}/refund`;
      const reviewUrl = `/admin/attendees/${attendeeId}/payment-review`;
      const deleteUrl = `/admin/attendees/${attendeeId}/delete`;

      const ordinary = await tabHtml(attendeeId, "actions");
      expect(ordinary).toContain(refundUrl);
      expect(ordinary).not.toContain(reviewUrl);
      expect(ordinary).toContain(deleteUrl);

      await putRowState(
        sessionId,
        await staleClaimSlot(attendeeId, "checking"),
        CLAIM_MIRROR,
      );
      const stale = await tabHtml(attendeeId, "actions");
      expect(stale).not.toContain(refundUrl);
      expect(stale).not.toContain(reviewUrl);
      expect(stale).not.toContain(deleteUrl);

      await putRowState(
        sessionId,
        await freshClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );
      const inProgress = await tabHtml(attendeeId, "actions");
      expect(inProgress).not.toContain(refundUrl);
      expect(inProgress).not.toContain(reviewUrl);
      expect(inProgress).not.toContain(deleteUrl);
    });
  });

  describe("merging", () => {
    test("does not render a merge submit whose claimed payment cannot move", async () => {
      const { attendeeId, sessionId } = await paidPagePayment("merge-claim");
      const { token: sourceToken } = await createTestAttendeeWithToken(
        "Source Person",
        "source@example.com",
      );
      await putRowState(
        sessionId,
        await freshClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );

      const response = await withTestSession(() =>
        attendeePage.renderPage(OWNER, attendeeId, "actions", {
          query: new URLSearchParams({ token: sourceToken }),
        }),
      );
      const html = await response.text();

      expect(html).toContain("A refund for this person is still in progress");
      expect(html).not.toContain("Merge and delete source attendee");
      expect(html).not.toContain(`/admin/attendees/${attendeeId}/merge`);
    });

    test("keeps movable review, ledger, and provider work in the merge form", async () => {
      const suffix = "merge-movable";
      const paymentId = `pi_page_${suffix}`;
      const { attendeeId, sessionId } = await paidPagePayment(suffix, "sumup");
      const { token: sourceToken } = await createTestAttendeeWithToken(
        "Movable Source",
        "movable-source@example.com",
      );
      const preview = async (): Promise<string> => {
        const response = await withTestSession(() =>
          attendeePage.renderPage(OWNER, attendeeId, "actions", {
            query: new URLSearchParams({ token: sourceToken }),
          }),
        );
        return response.text();
      };

      await putRowState(
        sessionId,
        await rowStateSlot({
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        REVIEW_MIRROR,
      );
      expect(await preview()).toContain("Merge and delete source attendee");

      await putRowState(
        sessionId,
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-08-12T10:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );
      expect(await preview()).toContain("Merge and delete source attendee");

      await putRowState(sessionId, await rowStateSlot({}), "");
      await addProviderRefundTestCase(paymentId);
      expect(await preview()).toContain("Merge and delete source attendee");
    });

    test("looks up the ticket the caller named, and says when there is none", async () => {
      const id = await bookAttendee();
      const response = await withTestSession(() =>
        attendeePage.renderPage(OWNER, id, "actions", {
          query: new URLSearchParams({ token: "no-such-ticket" }),
        }),
      );
      expect(await response.text()).toContain("Ticket token not found");
    });

    test("looks nothing up when the caller named no ticket", async () => {
      const id = await bookAttendee();
      const html = await tabHtml(id, "actions");
      expect(html).not.toContain("Ticket token not found");
    });
  });
});
