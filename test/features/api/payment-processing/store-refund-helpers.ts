import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { requirePublicStatusId } from "#db/attendee-statuses.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { reserveSession } from "#db/processed-payments.ts";
import {
  placeholderBookings,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectLegalJointStates } from "#test-utils/joint-state.ts";
import { bookingIntent, trustedPayment } from "./index/helpers.ts";

export const placeholderSpec = (detail: string) =>
  specForFailure({ detail, ok: false, reason: "capacity_exceeded" });

/** One reserved paid booking ready to become a quantity-0 placeholder. */
export const reservedPlaceholder = async (id: string) => {
  const listing = await createTestListing({});
  const intent = bookingIntent([{ e: listing.id, p: 1000, q: 1 }]);
  const data = trustedPayment(id, intent, 1000);
  const bookings = placeholderBookings(
    [{ expectedPrice: 1000, item: intent.items[0]!, listing }],
    intent,
  );
  await reserveSession(id);
  return { bookings, data, intent, listing };
};

export const storePlaceholder = async (
  placeholder: Awaited<ReturnType<typeof reservedPlaceholder>>,
) =>
  await storeRefundedBooking(
    placeholder.data.session,
    placeholder.intent,
    placeholder.bookings,
    placeholderSpec("listing full"),
    await requirePublicStatusId(),
  );

/** Store a placeholder for a paid-for booking on a real listing. */
export const storedPlaceholder = async (id: string) => {
  const placeholder = await reservedPlaceholder(id);
  return { ...placeholder, result: await storePlaceholder(placeholder) };
};

/** The ghost, claim, authority, and pending outcome all commit, then the
 * delivery dies before its refund tail runs at all — the exact crash the
 * redelivery resume has to finish. */
export const crashedPlaceholderStore = async (sessionId: string) => {
  const placeholder = await reservedPlaceholder(sessionId);
  const createAttendee = attendeesApi.createAttendeeAtomic;
  const broken = stub(
    attendeesApi,
    "createAttendeeAtomic",
    async (...args: Parameters<typeof createAttendee>) => {
      await createAttendee(...args);
      throw new Error("placeholder create reply was lost");
    },
  );
  try {
    await expect(storePlaceholder(placeholder)).rejects.toThrow(
      "placeholder create reply was lost",
    );
  } finally {
    broken.restore();
  }
  await expectLegalJointStates(sessionId, "after a crashed placeholder store");
  return placeholder;
};
