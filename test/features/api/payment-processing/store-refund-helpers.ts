import {
  placeholderBookings,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
