/** Provider-neutral checkout, callback, and refund contracts. */

/* jscpd:ignore-start */
import * as v from "valibot";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { settings } from "#db/settings.ts";
import type { Currency } from "#payment/money.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type { SessionRejection } from "#payment/validated-session.ts";
import type { ListingAnswerRefs } from "#shared/booking-intent.ts";
import { existingPaymentProviderState } from "#shared/existing-payment-provider.ts";
import { logDebug } from "#shared/logger.ts";
import type { CalcKind, ModifierTrigger } from "#shared/price-modifier.ts";
import type { ContactInfo, PaymentProviderType } from "#types";
/* jscpd:ignore-end */

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const paymentsApi = {
  getConfiguredProvider: (): PaymentProviderType | null =>
    settings.paymentProvider,
};

/** Re-export from types.ts (canonical definition) */
export type { PaymentProviderType };

/** Single item within a checkout — one bookable PATH. A listing booked through
 * two overlapping packages (or a package plus its own standalone row) in one
 * order is one item per path, each with its own quantity and price. */
export type CheckoutItem = {
  listingId: number;
  quantity: number;
  unitPrice: number;
  slug: string;
  name: string;
  /** The package this line books through (absent = a standalone/child line).
   * Signed per line as the item's `k`/`r` edge tag and stamped onto the line's
   * booking row. */
  packageGroupId?: number | undefined;
};

/** Build a standalone-line {@link CheckoutItem} for one listing — the shared
 * shape every single-listing checkout (direct-to-provider QR booking, the
 * plain public booking form) builds its one-item `items` array from. */
export const checkoutItem = (
  listing: Pick<CheckoutItem, "name" | "slug"> & { id: number },
  quantity: number,
  unitPrice: number,
): CheckoutItem => ({
  listingId: listing.id,
  name: listing.name,
  quantity,
  slug: listing.slug,
  unitPrice,
});

/**
 * A modifier resolved for a specific checkout — the input the pricing pipeline
 * applies. Eligibility (scope, stock, codes) is decided upstream; by the time a
 * spec reaches pricing it is known to apply. `value` is the signed calc value
 * (see `modifierDelta`); `listingIds` scopes which items it is charged on
 * (`null` = the whole order); `quantity` is how many the buyer took (1 for an
 * automatic or code modifier, more for an opt-in add-on).
 */
export type ModifierSpec = {
  id: number;
  name: string;
  kind: CalcKind;
  trigger: ModifierTrigger;
  value: number;
  listingIds: number[] | null;
  quantity: number;
};

/** Fields shared between BookingIntent and CheckoutIntent that carry
 * deposit, redirect, and child-allocation metadata through the checkout. */
type CheckoutMetaFields = {
  /** Reserved attendee whose outstanding balance this session settles. */
  balanceAttendeeId?: number | undefined;
  /** Pricing rule used to re-derive a deposit and its balance. */
  reservationAmount?: string | undefined;
  /** Explicit redirect that survives the paid round-trip. */
  thankYouUrl?: string | undefined;
  /** Child bookings assigned to their parent rows. */
  allocations?: ChildAllocation[] | undefined;
};

/** Fields shared by the booking and checkout intents: the contact, answer,
 * and deposit/redirect metadata plus the booking date and shared day count. */
type CheckoutIntentBase = ContactInfo &
  ListingAnswerRefs &
  CheckoutMetaFields & {
    date: string | null;
    /** Visitor-chosen day count for "customisable days" listings (shared across
     * the checkout). Absent when no selected listing is customisable. */
    dayCount?: number | undefined;
  };

/** Registration intent for checkout (one or more listings) */
export type CheckoutIntent = CheckoutIntentBase & {
  items: CheckoutItem[];
  /** Modifiers (surcharges, add-ons, …) resolved for this checkout. Absent or
   * empty when none apply. Applied to the price by the checkout-pricing layer. */
  modifiers?: ModifierSpec[];
  /** Plain site renewal token from /renew. Hashed before storage in provider
   * metadata; never stored at the provider in plaintext. */
  siteToken?: string;
  /** Override the subtotal the booking fee is calculated on (defaults to the
   * item subtotal). Used so a deposit charges the fee on the full order, and a
   * balance payment charges no fee (the fee was collected up front). */
  feeSubtotal?: number;
};

/** Result of creating a checkout session.
 * - Success: { sessionId, checkoutUrl }
 * - User-facing error (e.g. invalid phone): { error }
 * - Provider not configured: null
 * Unexpected failures throw. */
export type CheckoutSessionResult =
  | {
      sessionId: string;
      checkoutUrl: string;
    }
  | {
      error: string;
    }
  | null;

/** Validated logical metadata. Missing wire values are represented by `""`;
 * provider-specific packing is removed at extraction. */
export type SessionMetadata = ContactInfo & {
  _origin: string;
  items: string;
  date: string;
  day_count: string;
  answer_ids: string;
  text_answer_ids: string;
  site_token_index: string;
  /** Attendee id when this session settles an outstanding balance ("" if not). */
  balance_attendee_id: string;
  /** Reservation-amount snapshot when the items are deposit-priced ("" if not). */
  reservation_amount: string;
  /** JSON array of applied modifier references ("" when none applied). */
  modifiers: string;
  /** Explicit thank-you redirect a parent booking carries so a folded child
   * doesn't drop it ("" when the default single-listing derivation applies). */
  thank_you_url: string;
  /** JSON-encoded ChildAllocation[] from the fold, carried through the paid
   * round-trip so the webhook can expand child bookings into per-parent rows.
   * "" when no children were folded. */
  allocations: string;
  /** The agreed order total (minor units) the buyer was charged, packed with a
   * server HMAC over the price/booking fields as `total.sig` in a single key —
   * one entry rather than two, to stay within providers' metadata-entry caps
   * (Square allows only 10). "" only on legacy/unsigned sessions. */
  price_proof: string;
};

/** Schema for valid payment status values. "failed" is a terminal non-payment
 * (declined or expired checkout) — distinct from "unpaid", which may still
 * complete. */
export const PaymentStatusSchema = v.picklist([
  "paid",
  "unpaid",
  "no_payment_required",
  "failed",
]);

/** Valid payment status value */
export type PaymentStatus = v.InferOutput<typeof PaymentStatusSchema>;

/** A validated payment session returned after checkout completion */
export type ValidatedPaymentSession = {
  id: string;
  paymentStatus: PaymentStatus;
  paymentReference: string;
  /** Provider that authenticated and read this session. This is evidence about
   *  the charge, unlike the site's currently selected provider. */
  provider: PaymentProviderType;
  /** Total amount charged in smallest currency unit (cents), from the payment provider.
   *  Validated at the provider boundary alongside its currency, so a malformed
   *  amount never reaches a callback. */
  amountTotal: number;
  /** The three-letter currency the provider charged in. The callbacks refuse a
   *  charge in any currency other than the site's — it cannot be honored at the
   *  signed total — by treating it as a price mismatch. */
  currency: Currency;
  metadata: SessionMetadata;
  /**
   * When the provider created this checkout, in the ledger's canonical ISO 8601
   * form (`YYYY-MM-DDTHH:mm:ss.sssZ`), or undefined if the provider didn't supply
   * a usable timestamp. Each provider normalises its own format (see
   * toCanonicalIso) so this is safe to use directly as a ledger occurredAt. It is
   * the customer's business time, so a payment processed late — a delayed
   * webhook, an old redirect, a stale retry — is still recognised on the day it
   * was paid, not the day we happened to process it.
   */
  createdAt?: string | undefined;
};

/** Result of webhook signature verification */
export type WebhookVerifyResult =
  | { valid: true; listing: WebhookEvent }
  | { valid: false; error: string };

/** Everything resolving a webhook's session can come back as: the session;
 *  "skip" to acknowledge without processing; "retry" to answer with the fixed
 *  retryable refusal; a rejection carrying a paid charge the boundary could
 *  not read; or null for an event that is provably not ours. */
export type WebhookSessionResult =
  | ValidatedPaymentSession
  | "skip"
  | "retry"
  | SessionRejection
  | null;

/** Everything retrieving a checkout session by id can come back as. */
export type RetrieveSessionResult =
  | ValidatedPaymentSession
  | SessionRejection
  | null;

/** Provider-agnostic webhook event */
export type WebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
};

/** Result of webhook endpoint setup */
export type WebhookSetupResult =
  | { success: true; endpointId: string; secret: string }
  | { success: false; error: string };

/** Set up a webhook endpoint for a provider. Some providers (e.g. Stripe)
 * support programmatic creation; recreating any existing endpoint returns a
 * fresh signing secret. Shared by the provider interface and each provider's
 * own implementation so the signature can't drift. */
export type SetupWebhookEndpoint = (
  secretKey: string,
  webhookUrl: string,
  existingEndpointId?: string | null,
) => Promise<WebhookSetupResult>;

/** Operations every configured payment provider supplies. */
export interface PaymentProvider {
  /** The webhook event type name that indicates a completed checkout */
  readonly checkoutCompletedEventType: string;

  /** Create a checkout for one or more listings. */
  createCheckoutSession(
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult>;

  /**
   * Read what the provider says about the money on one charge: what it took,
   * and what has gone back. Every refund route asks this before it sends money,
   * and the edit-attendee page asks it to refresh a booking's refund state.
   *
   * @param paymentReference - provider-specific payment reference
   * Missing, unavailable, and invalid answers remain distinct.
   */
  readCharge(paymentReference: string): Promise<ProviderRead<ChargeMoney>>;

  /** Ask for the observed charge to be refunded and preserve the provider's
   * exact completed, accepted, rejected, unsent, or uncertain answer. */
  refundCharge(request: AuthorizedRefundRequest): Promise<RefundAttemptResult>;

  /**
   * Resolve a validated session from a webhook event.
   * Each provider knows how to extract/fetch session data from its own
   * event structure, so the webhook handler stays provider-agnostic.
   *
   * @returns the session; "skip" if the event should be acknowledged
   *          without processing (e.g. pending payment); "retry" when the
   *          provider could not be read or its answer contradicted our facts,
   *          so the route must refuse with the fixed retryable response and
   *          let redelivery try again; a rejection when the provider reported
   *          a paid charge the boundary could not read; or null for an event
   *          that is provably not ours.
   */
  resolveWebhookSession(listing: WebhookEvent): Promise<WebhookSessionResult>;

  /**
   * Retrieve and validate a completed checkout session by ID.
   * Returns the validated session, a rejection when the provider reported a
   * paid charge the boundary could not read, or null if not found.
   *
   * `paidPaymentId` is a payment the caller has already been told is complete —
   * a webhook has one, a redirect does not. A provider whose session lags
   * behind the payment uses it so a captured charge is not read as unpaid.
   */
  retrieveSession(
    sessionId: string,
    paidPaymentId?: string,
  ): Promise<RetrieveSessionResult>;

  /** Set up the provider's webhook endpoint where supported. */
  setupWebhookEndpoint: SetupWebhookEndpoint;
  /** Provider identifier */
  readonly type: PaymentProviderType;

  /**
   * Verify a webhook request's signature and parse the listing payload.
   * @param webhookUrl - The webhook endpoint URL derived from the incoming request
   * @param payloadBytes - Raw body bytes from request.arrayBuffer()
   */
  verifyWebhookSignature(
    payload: string,
    signature: string,
    webhookUrl: string,
    payloadBytes: Uint8Array,
  ): Promise<WebhookVerifyResult>;
}

/**
 * Resolve the active payment provider based on admin settings.
 * Lazy-loads the provider module to avoid importing unused SDKs.
 * Returns null if no provider is configured.
 */
/** Lazy module loaders per provider — avoids importing unused SDKs. */
const providerLoaders: Record<
  PaymentProviderType,
  () => Promise<PaymentProvider>
> = {
  square: async () =>
    (await import("#shared/square-provider.ts")).squarePaymentProvider,
  stripe: async () =>
    (await import("#shared/stripe-provider.ts")).stripePaymentProvider,
  sumup: async () =>
    (await import("#shared/sumup-provider.ts")).sumupPaymentProvider,
};

/** Load one explicitly named provider implementation. */
export const loadPaymentProvider = (
  provider: PaymentProviderType,
): Promise<PaymentProvider> => providerLoaders[provider]();

/** Resolve a provider type and lazy-load its implementation. */
const resolveProvider = async (
  resolveType: () => PaymentProviderType | null,
  label: string,
  onMissing?: () => void,
): Promise<PaymentProvider | null> => {
  const providerType = resolveType();
  if (!providerType) {
    onMissing?.();
    return null;
  }
  logDebug("Payment", `Resolving payment provider${label}: ${providerType}`);
  return loadPaymentProvider(providerType);
};

export const getActivePaymentProvider = (): Promise<PaymentProvider | null> =>
  resolveProvider(paymentsApi.getConfiguredProvider, "", () =>
    logDebug("Payment", "No payment provider configured in settings"),
  );

/** Provider implementation for work on an existing payment. */
export type ExistingPaymentProvider = PaymentProvider | null;

/**
 * Resolve the provider for callbacks and completion of payments that already
 * exist. New sales use {@link getActivePaymentProvider}.
 */
export const getPaymentProviderForExistingPayments =
  (): Promise<ExistingPaymentProvider> =>
    resolveProvider(
      () =>
        existingPaymentProviderState(paymentsApi.getConfiguredProvider())
          .provider,
      " for existing payments",
    );
