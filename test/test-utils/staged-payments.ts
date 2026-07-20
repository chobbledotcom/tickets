/* jscpd:ignore-start */

import { assert } from "@std/assert";
import { compact, requiredMapValue } from "#fp";
import { classifySession } from "#routes/api/payment-processing/classify.ts";
import { bookingSlot } from "#routes/api/payment-processing/create.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import { bookingsForOrder } from "#shared/booking-lines.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import {
  loadCheckoutStageByPaymentSession,
  pendingCheckoutStageInsert,
} from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProviderType,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { bookingLedgerDisposition } from "#shared/session-ledger.ts";
import { stripeApi } from "#shared/stripe.ts";
/* jscpd:ignore-end */

/** Give a simulated paid callback the stage its earlier checkout creation would
 * have stored in production. Invalid and balance sessions deliberately skip it. */
export const stagePaymentCallback = async (fields: {
  amountTotal: number;
  metadata: SessionMetadata | Record<string, string>;
  paymentReference: string;
  provider?: PaymentProviderType;
  providerCheckoutId?: string;
  sessionId: string;
}): Promise<void> => {
  if (await loadCheckoutStageByPaymentSession(fields.sessionId)) return;
  if (await isSessionProcessed(fields.sessionId)) return;
  if (
    (await bookingLedgerDisposition(fields.sessionId)).status !== "unrecorded"
  ) {
    return;
  }
  if (!hasRequiredSessionMetadata(fields.metadata)) return;
  const metadata = extractSessionMetadata(fields.metadata);
  const session: ValidatedPaymentSession = {
    amountTotal: fields.amountTotal,
    id: fields.sessionId,
    metadata,
    paymentReference: fields.paymentReference,
    paymentStatus: "paid",
  };
  if ((await classifySession(session)).verdict === "ignore") return;
  const intent = extractIntent(session);
  assert(intent, `Could not extract booking intent for ${fields.sessionId}`);
  if (intent.balanceAttendeeId) return;
  const listingIds = [...new Set(intent.items.map((item) => item.e))];
  const listings = await getListingsWithCountsByIds(listingIds);
  const foundListings = compact(listings);
  const listingById = new Map(
    foundListings.map((listing) => [listing.id, listing]),
  );
  const inactiveIds = foundListings
    .filter((listing) => !listing.active)
    .map((listing) => listing.id);
  if (inactiveIds.length > 0) {
    await execute(
      `UPDATE listings SET active = 1 WHERE id IN (${inactiveIds.map(() => "?").join(", ")})`,
      inactiveIds,
    );
  }
  try {
    const bookings = bookingsForOrder(
      intent,
      intent.items.map((item) => ({
        ...bookingSlot(item),
        listing: requiredMapValue(
          listingById,
          item.e,
          `Listing ${item.e} was not loaded for staged payment`,
        ),
        quantity: item.q,
      })),
    );
    const attendeeInput = {
      address: intent.address,
      bookings: bookings.map((booking) => ({ ...booking, quantity: 0 })),
      email: intent.email,
      name: intent.name,
      phone: intent.phone,
      special_instructions: intent.special_instructions,
      statusId: await requirePublicStatusId(),
    };
    const staged = await attendeesApi.createStagedCheckoutAtomic(
      attendeeInput,
      {
        paymentSessionId: fields.sessionId,
        provider: fields.provider ?? "stripe",
        providerCheckoutId: fields.providerCheckoutId ?? fields.sessionId,
      },
    );
    if (!staged.success) {
      const attendee = await attendeesApi.createAttendeeAtomic({
        ...attendeeInput,
        allowOverbook: true,
      });
      assert(attendee.success, "Could not stage payment callback");
      const first = attendee.attendees[0]!;
      const stage = await pendingCheckoutStageInsert(
        {
          paymentSessionId: fields.sessionId,
          provider: fields.provider ?? "stripe",
          providerCheckoutId: fields.providerCheckoutId ?? fields.sessionId,
        },
        "?",
        [first.id],
        first.ticket_token,
      );
      await execute(stage.sql, stage.args);
    }
  } finally {
    if (inactiveIds.length > 0) {
      await execute(
        `UPDATE listings SET active = 0 WHERE id IN (${inactiveIds.map(() => "?").join(", ")})`,
        inactiveIds,
      );
    }
  }
};

/** Stage the paid session returned by a test's Stripe retrieval stub before
 * driving the redirect that will retrieve it again. */
export const stageStripeCallback = async (sessionId: string): Promise<void> => {
  const session = await stripeApi.retrieveCheckoutSession(sessionId);
  assert(session, `Could not retrieve staged session ${sessionId}`);
  assert(session.amount_total !== null, `Session ${sessionId} has no total`);
  assert(session.metadata, `Session ${sessionId} has no metadata`);
  assert(
    typeof session.payment_intent === "string",
    `Session ${sessionId} has no payment reference`,
  );
  await stagePaymentCallback({
    amountTotal: session.amount_total,
    metadata: session.metadata,
    paymentReference: session.payment_intent,
    sessionId,
  });
};
