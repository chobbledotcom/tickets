import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { getRefundPaymentReferencesForAttendee } from "#shared/db/payment-references.ts";
import { listProviderRefundCases } from "#shared/db/provider-refund-cases.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import {
  finishedCounts,
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { protectedStateOf } from "#test-utils/payment-claim.ts";
import { requireCompleteRefundReferences } from "#test-utils/payment-references.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

const SESSION_ID = "sess_uncertain_claim_lifecycle";
const PAYMENT_REFERENCE = "pi_uncertain_claim_lifecycle";

const loadCandidate = async (attendeeId: number): Promise<RefundCandidate> => {
  const privateKey = await getTestPrivateKey();
  const attendee = await getAttendeeOrNull(attendeeId, privateKey);
  if (attendee === null) {
    throw new Error(`Attendee ${attendeeId} was not found`);
  }
  return {
    attendee,
    references: requireCompleteRefundReferences(
      await getRefundPaymentReferencesForAttendee(
        { currentPaymentId: attendee.payment_id, id: attendee.id },
        privateKey,
      ),
    ),
  };
};

describeWithEnv(
  "admin refund provider > uncertain claim lifecycle",
  { db: true, encryptionKey: true },
  () => {
    setupErrorSpy();

    test("holds an uncertain send through delete until fresh evidence settles it", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const attendee = bookedAttendee(
        await bookAttendee(listing, {
          email: "uncertain@example.com",
          name: "Uncertain Buyer",
        }),
      );
      await postListingSale({
        attendeeId: attendee.id,
        eventId: SESSION_ID,
        gross: 1000,
        listingId: listing.id,
      });
      await finalizeProcessedPayment(
        SESSION_ID,
        attendee.id,
        "tok-uncertain",
        taggedPaymentReference(PAYMENT_REFERENCE),
      );

      const firstCandidate = await loadCandidate(attendee.id);
      expect(
        firstCandidate.references.map((reference) => reference.reference),
      ).toEqual([PAYMENT_REFERENCE]);

      let reads = 0;
      let sends = 0;
      const readBeforeSettlement = (): Promise<ProviderRead<ChargeMoney>> => {
        reads++;
        return Promise.resolve({ resource: chargeMoney(), status: "found" });
      };
      const uncertainProvider = provider({
        read: async () => {
          const read = await readBeforeSettlement();
          return read.status === "found" ? read.resource : null;
        },
        refund: () => {
          sends++;
          return Promise.resolve({
            kind: "uncertain",
            reason: "network_error",
          });
        },
        refundCapability: "keyed",
      });

      await processRefundBatchAt(
        uncertainProvider,
        [firstCandidate],
        listing.id,
        {
          recordAuthorities: recordProviderRefunds,
          request: requestProviderRefund,
        },
      );

      expect(reads).toBe(1);
      expect(sends).toBe(1);
      expect(await protectedStateOf(SESSION_ID)).toBe("");
      expect((await listProviderRefundCases()).cases).toEqual([
        expect.objectContaining({ state: "observing" }),
      ]);
      await expect(deleteAttendee(attendee.id)).rejects.toThrow(
        "A provider refund for this payment is still in progress",
      );
      let retrySends = 0;
      const settledProvider = provider({
        read: () => Promise.resolve(fullyRefundedMoney()),
        refund: () => {
          retrySends++;
          return Promise.resolve({ kind: "rejected", reason: "failed" });
        },
        refundCapability: "keyed",
      });

      const settled = finishedCounts(
        await processRefundBatchAt(
          settledProvider,
          [await loadCandidate(attendee.id)],
          listing.id,
          {
            recordAuthorities: recordProviderRefunds,
            request: requestProviderRefund,
          },
        ),
      );

      expect(retrySends).toBe(0);
      expect(settled.refundedCount).toBe(1);
      expect(await protectedStateOf(SESSION_ID)).toBe("");
      await expect(deleteAttendee(attendee.id)).resolves.toBeUndefined();
    });
  },
);
