/* jscpd:ignore-start */
import { assertExists } from "@std/assert";
import type { CanonicalOrderBooking } from "#shared/booking-lines.ts";
import type {
  StagedActivationInput,
  StagedActivationPlan,
} from "#shared/db/attendees/activate.ts";
import { createStagedCheckoutAtomic } from "#shared/db/attendees/create.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
/* jscpd:ignore-end */

export const stagedContact = {
  address: "1 Test Road",
  email: "staged@example.com",
  name: "Staged Buyer",
  phone: "",
  special_instructions: "Near the door",
};

export const setupActivationStage = async (
  sessionId: string,
  bookings: CanonicalOrderBooking[],
): Promise<{
  input: StagedActivationInput;
  plan: StagedActivationPlan;
  stage: NonNullable<
    Awaited<ReturnType<typeof loadCheckoutStageByPaymentSession>>
  >;
}> => {
  await createStagedCheckoutAtomic(
    {
      ...stagedContact,
      bookings: bookings.map((booking) => ({ ...booking, quantity: 0 })),
      ticketToken: `ticket-${sessionId}`,
    },
    {
      paymentSessionId: sessionId,
      provider: "stripe",
      providerCheckoutId: `checkout-${sessionId}`,
    },
  );
  await reserveSession(sessionId);
  const stage = await loadCheckoutStageByPaymentSession(sessionId);
  assertExists(stage, "Expected checkout stage");
  return {
    input: {
      ...stagedContact,
      bookings,
      paymentId: `payment-${sessionId}`,
    },
    plan: {
      finalize: {
        paymentReference: `payment-${sessionId}`,
        sessionId,
      },
      legs: [],
      usages: [],
    },
    stage,
  };
};

export const activationBooking = (
  listingId: number,
  overrides: Partial<CanonicalOrderBooking> = {},
): CanonicalOrderBooking => ({
  date: null,
  durationDays: 1,
  listingId,
  pricePaid: 1000,
  quantity: 1,
  ...overrides,
});

export const storedActivationRows = async (attendeeId: number) =>
  (
    await getDb().execute({
      args: [attendeeId],
      sql: `SELECT listing_id, start_at, end_at, quantity, parent_listing_id,
                   package_group_id, ledger_event_group
              FROM listing_attendees WHERE attendee_id = ? ORDER BY listing_id`,
    })
  ).rows;
