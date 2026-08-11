import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getRefundPaymentReferencesForAttendee,
  markPaymentReferencesProviderRefunded,
} from "#shared/db/payment-references.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import {
  createPaidListing,
  markAsRefunded,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  protectedStateOf,
  putRowState,
  staleClaimSlot,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import {
  postRefundAll,
  refundAllUrl,
  refundUrl,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { testCookie } from "#test-utils/session.ts";

describeWithEnv("server (admin refund state)", { db: true }, () => {
  describe("already-refunded guard", () => {
    test("GET refund page shows error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_already_refunded");
      await markAsRefunded(ctx.attendee.id);

      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });
      await expectHtmlResponse(response, 400, "already been refunded");
    });

    test("POST refund returns error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_post_already");
      await markAsRefunded(ctx.attendee.id);

      const response = await submitRefund(ctx);
      await expectFlashRedirect(
        `/admin/attendees/${ctx.attendee.id}/refund`,
        expect.stringContaining("already been refunded"),
        false,
      )(response);
    });

    test("refund-all excludes already-refunded attendees", async () => {
      const listing = await createPaidListing();
      const refundedAttendee = await createPaidTestAttendee(
        listing.id,
        "Refunded",
        "refunded@example.com",
        "pi_ra_1",
      );
      await createPaidTestAttendee(
        listing.id,
        "Not Refunded",
        "notrefunded@example.com",
        "pi_ra_2",
      );
      await markAsRefunded(refundedAttendee.id);

      const response = await awaitTestRequest(refundAllUrl(listing.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "1 attendee(s) with payments");
    });

    // The fault this closes: a run refunded the money, marked the charge and
    // posted the ledger, then lost the write that lets go of its hold. That
    // hold refuses the person's delete AND their merge, and tells the operator
    // to re-run the refund — but a person whose money was all back was no
    // longer picked up, so no re-run could ever reach them. Stuck for good.
    test("refund-all frees an attendee a crashed run is still holding", async () => {
      const listing = await createPaidListing();
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Stranded",
        "stranded@example.com",
        "",
      );
      await finalizeProcessedPayment(
        "sess_stranded",
        attendee.id,
        "",
        "pi_stranded",
      );
      await markPaymentReferencesProviderRefunded(
        await getRefundPaymentReferencesForAttendee(
          attendee,
          await getTestPrivateKey(),
        ),
      );
      await markAsRefunded(attendee.id);
      await putRowState(
        "sess_stranded",
        await staleClaimSlot(attendee.id),
        CLAIM_MIRROR,
      );

      await withRefundMock(true, async () => {
        await postRefundAll(listing);
      });

      expect(await protectedStateOf("sess_stranded")).toBe("");
    });

    test("marks attendee as refunded after successful refund", async () => {
      const ctx = await setupRefundTest("pi_mark_refund");

      await withRefundMock(true, async () => {
        const response = await submitRefund(ctx);
        expect(response.status).toBe(302);

        const retryResponse = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          expect.stringContaining("already been refunded"),
          false,
        )(retryResponse);
      });
    });
  });
});
