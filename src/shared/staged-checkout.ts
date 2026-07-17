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
import type { CheckoutStageCleanup } from "#shared/db/checkout-stages.ts";
import { checkoutStagesApi } from "#shared/db/checkout-stages.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import { logDebug } from "#shared/logger.ts";
import { isoBefore } from "#shared/now.ts";
import type {
  CheckoutIntent,
  CheckoutSessionResult,
  PaymentProvider,
} from "#shared/payments.ts";
import { getPaymentProvider } from "#shared/payments.ts";
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

const CHECKOUT_STAGE_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Close one hosted checkout, then purge its local stage only after closure. */
export const closeAndPurgeCheckoutStage = async (
  stage: CheckoutStageCleanup,
  provider: PaymentProvider,
): Promise<"kept" | "paid" | "purged"> => {
  const result = await provider.closeCheckout({
    providerCheckoutId: stage.providerCheckoutId,
    sessionId: stage.paymentSessionId,
  });
  if (result === "paid") return "paid";
  return (await checkoutStagesApi.purgePending(stage)) ? "purged" : "kept";
};

/** Close a known stage at a provider callback boundary. No stage is a no-op. */
export const closeAndPurgeCheckoutStageBySession = async (
  paymentSessionId: string,
  provider: PaymentProvider,
): Promise<"kept" | "missing" | "paid" | "purged"> => {
  const stage = await checkoutStagesApi.loadByPaymentSession(paymentSessionId);
  if (stage === null) return "missing";
  if (stage.provider !== provider.type) {
    throw new Error(
      `Checkout stage ${paymentSessionId} provider did not match`,
    );
  }
  if (stage.state === "refunding") return "kept";
  return closeAndPurgeCheckoutStage(stage, provider);
};

/** Try callback-boundary cleanup without making the customer/provider retry.
 * Scheduled pruning remains the backstop when closure fails. */
export const tryCloseAndPurgeCheckoutStageBySession = async (
  paymentSessionId: string,
  provider: PaymentProvider,
  onError: (error: unknown) => void,
): Promise<"error" | "kept" | "missing" | "paid" | "purged"> => {
  try {
    return await closeAndPurgeCheckoutStageBySession(
      paymentSessionId,
      provider,
    );
  } catch (error) {
    onError(error);
    return "error";
  }
};

/** Close and purge one bounded batch of abandoned pending stages. */
export const pruneAbandonedCheckoutStages = async (): Promise<number> => {
  const cutoff = isoBefore(CHECKOUT_STAGE_RETENTION_MS);
  const stages = await checkoutStagesApi.selectOldPending(cutoff);
  let purged = 0;
  for (const stage of stages) {
    try {
      const provider = await getPaymentProvider(stage.provider);
      if ((await closeAndPurgeCheckoutStage(stage, provider)) === "purged") {
        purged += 1;
      }
    } catch (error) {
      logDebug(
        "Prune",
        `checkout stage close failed (provider=${stage.provider}, session=${stage.paymentSessionId}): ${String(error)}`,
      );
    }
  }
  return purged;
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
