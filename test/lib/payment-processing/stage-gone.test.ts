/**
 * A staged attendee losing its booking rows before activation claims them is an
 * IMPOSSIBLE state: a pending stage's rows are only removed with the stage
 * itself, and admin/listing deletes are blocked while pending. If it is ever
 * observed it is a missed cascade, so activation throws loudly rather than
 * silently re-running the create with the customer already gone. This drives
 * createAttendeeForSession directly with a stale stage snapshot whose attendee
 * was removed, composing its inputs with the same production functions the
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
import { reserveSession } from "#shared/db/processed-payments.ts";
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
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "paid checkout > staged rows gone at claim",
  { db: true },
  () => {
    test("throws on the impossible gone-stage state instead of booking fresh", async () => {
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

      // The staged rows vanished out from under the claim — an impossible state
      // in production (admin/listing deletes are blocked while pending), so the
      // activation surfaces it loudly instead of quietly re-running the create.
      await expect(
        createAttendeeForSession(
          session,
          intent,
          validated.items,
          pricingIntent,
          priceCheckout(pricingIntent),
          staleStage.ticketToken,
          staleStage,
        ),
      ).rejects.toThrow("has no booking rows at activation");
    });
  },
);
