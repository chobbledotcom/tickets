/* jscpd:ignore-start */
import { identity, mapById } from "#fp";
import {
  bookingsForOrder,
  type CanonicalOrderBooking,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import { checkoutStagesApi } from "#shared/db/checkout-stages.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import type {
  CheckoutIntent,
  CheckoutSessionResult,
  PaymentProvider,
} from "#shared/payments.ts";
/* jscpd:ignore-end */

export type PaidCheckoutResult =
  | { type: "sold_out" }
  | { type: "checkout_failed"; error?: string }
  | {
      type: "checkout";
      checkoutUrl: string;
      providerCheckoutId: string;
      sessionId: string;
    };

type CreatePaidCheckoutInput = {
  baseUrl: string;
  intent: CheckoutIntent;
  provider: PaymentProvider;
};

type PaidCheckoutHandlers<T> = {
  checkout: (checkoutUrl: string) => T;
  failed: (error?: string) => T;
  soldOut: () => T;
};

export const handlePaidCheckoutResult = <T>(
  result: PaidCheckoutResult,
  handlers: PaidCheckoutHandlers<T>,
): T => {
  if (result.type === "sold_out") return handlers.soldOut();
  if (result.type === "checkout_failed") return handlers.failed(result.error);
  return handlers.checkout(result.checkoutUrl);
};

export const createAndHandlePaidCheckout = async <T>(
  input: CreatePaidCheckoutInput,
  handlers: PaidCheckoutHandlers<T>,
): Promise<T> =>
  handlePaidCheckoutResult(await createPaidCheckout(input), handlers);

/** Build the same booking identities payment completion uses, before quantities
 * are zeroed for staging. Listing facts are loaded in one collection query even
 * for a single-item checkout. */
export const paidCheckoutBookings = async (
  intent: CheckoutIntent,
): Promise<CanonicalOrderBooking[]> => {
  const listingIds = [...new Set(intent.items.map((item) => item.listingId))];
  const listings = await getListingsWithCountsByIds(listingIds);
  const listingById = mapById(identity<(typeof listings)[number]>)(listings);
  if (listingById.size !== listingIds.length) {
    throw new Error("Could not load every listing for paid checkout");
  }
  return bookingsForOrder(
    intent,
    checkoutBookingLines(intent.items, listingById),
  );
};

const failedCheckout = (result: CheckoutSessionResult): PaidCheckoutResult =>
  result && "error" in result
    ? { error: result.error, type: "checkout_failed" }
    : { type: "checkout_failed" };

const closeAfterStageFailure = async (
  provider: PaymentProvider,
  checkout: {
    providerCheckoutId: string;
    sessionId: string;
  },
  stageError: unknown,
): Promise<never> => {
  const closed = await provider.closeCheckout(checkout);
  if (closed === "paid") {
    throw new Error(
      `Checkout ${checkout.sessionId} was already paid before its stage could be stored`,
      { cause: stageError },
    );
  }
  throw new Error(`Could not store checkout stage ${checkout.sessionId}`, {
    cause: stageError,
  });
};

/** Preflight real demand, create the hosted checkout, then atomically stage its
 * attendee and zero-quantity booking identities before exposing the URL. */
export const createPaidCheckout = async ({
  baseUrl,
  intent,
  provider,
}: CreatePaidCheckoutInput): Promise<PaidCheckoutResult> => {
  const bookings = await paidCheckoutBookings(intent);
  const available = await attendeesApi.checkBatchAvailability(
    bookings.map((booking) => ({
      durationDays: booking.durationDays,
      listingId: booking.listingId,
      quantity: booking.quantity,
    })),
    intent.date,
  );
  if (!available) return { type: "sold_out" };

  const result = await provider.createCheckoutSession(intent, baseUrl);
  if (!result || "error" in result) return failedCheckout(result);

  try {
    const staged = await attendeesApi.createStagedCheckoutAtomic(
      {
        ...contactFields(intent),
        bookings: bookings.map((booking) => ({ ...booking, quantity: 0 })),
        statusId: await getPublicStatusId(),
      },
      {
        paymentSessionId: result.sessionId,
        provider: provider.type,
        providerCheckoutId: result.providerCheckoutId,
      },
    );
    if (!staged.success) {
      throw new Error(`Stage attendee creation failed: ${staged.reason}`);
    }
    const first = staged.attendees[0]!;
    if (
      !(await checkoutStagesApi.find(
        result.sessionId,
        first.id,
        first.ticket_token,
      ))
    ) {
      throw new Error(
        `Stored checkout stage did not match ${result.sessionId}`,
      );
    }
  } catch (error) {
    return closeAfterStageFailure(
      provider,
      {
        providerCheckoutId: result.providerCheckoutId,
        sessionId: result.sessionId,
      },
      error,
    );
  }
  return { ...result, type: "checkout" };
};
