/**
 * The stage-read race: an operator deletes a staged record after the payment
 * machine has read its stage but before activation claims the rows. Deleting
 * mid-payment is the one sanctioned mid-payment mutation, and its contract is
 * that a late payment books FRESH from the signed order — never a refund of a
 * bookable payment. This drives createAttendeeForSession directly with a stale
 * stage snapshot, composing its inputs with the same production functions the
 * route uses.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeForSession } from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import { checkoutIntentForSession } from "#routes/api/payment-processing/pricing.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { stageCheckout } from "#shared/db/checkout-stages.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  assembleCheckoutMetadata,
  extractSessionMetadata,
} from "#shared/payment-helpers.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeeQuantities } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "paid checkout > stage deleted mid-payment",
  { db: true },
  () => {
    test("books fresh from the signed order instead of refunding", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const captured = checkoutIntent({
        items: [
          checkoutItem({
            listingId: listing.id,
            name: listing.name,
            slug: listing.slug,
          }),
        ],
      });
      // The payment machine read this stage snapshot...
      const staleStage = await stageCheckout(
        "cs_stage_gone",
        "stripe",
        captured,
      );
      // ...then the operator deleted the record before activation claimed it.
      await deleteAttendee(staleStage.attendeeId);

      // The same raw-metadata → session shape every provider builds: assemble
      // the signed metadata, then normalize it the way the providers do.
      const session: ValidatedPaymentSession = {
        amountTotal: 1000,
        createdAt: new Date().toISOString(),
        id: "cs_stage_gone",
        metadata: extractSessionMetadata(
          (await assembleCheckoutMetadata(
            "stripe",
            captured,
            1000,
          )) as SessionMetadata,
        ),
        paymentReference: "pi_cs_stage_gone",
        paymentStatus: "paid",
      };
      const intent = extractIntent(session);
      if (!intent) throw new Error("Expected a parsable intent");
      const validated = await validateAllItems(session, intent);
      if ("success" in validated) throw new Error("Expected valid items");
      const pricingIntent = checkoutIntentForSession(
        intent,
        validated.items,
        [],
      );
      await reserveSession("cs_stage_gone");

      const honoured = await createAttendeeForSession(
        session,
        intent,
        validated.items,
        pricingIntent,
        priceCheckout(pricingIntent),
        staleStage.ticketToken,
        staleStage,
      );

      if (!honoured.ok) {
        throw new Error(`Expected a fresh booking, got ${honoured.reason}`);
      }
      const freshId = honoured.entries[0]!.attendee.id;
      expect(freshId).not.toBe(staleStage.attendeeId);
      expect(await getAttendeeQuantities(freshId)).toEqual([{ quantity: 1 }]);
      // The payment finalized against the fresh record, not the deleted one.
      expect((await isSessionProcessed("cs_stage_gone"))?.attendee_id).toBe(
        freshId,
      );
    });
  },
);
