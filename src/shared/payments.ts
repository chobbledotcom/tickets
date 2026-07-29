/**
 * Payment provider abstraction layer
 *
 * Defines a provider-agnostic interface for payment operations.
 * Admins choose a provider (e.g. Stripe) in settings; routes use
 * this interface so they never depend on a specific provider.
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import type { ListingAnswerRefs } from "#shared/booking-intent.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { settings } from "#shared/db/settings.ts";
import { logDebug } from "#shared/logger.ts";
import type { CalcKind, ModifierTrigger } from "#shared/price-modifier.ts";
import type { ContactInfo, PaymentProviderType } from "#shared/types.ts";
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
  /** When set, this session settles a reserved attendee's outstanding balance
   * (rather than creating a new attendee). */
  balanceAttendeeId?: number | undefined;
  /** Reservation amount string (e.g. "10%") — present when the items are
   * deposit-priced so the webhook can re-derive the deposit and the balance. */
  reservationAmount?: string | undefined;
  /** Explicit thank-you redirect carried through the paid round-trip, so a
   * single parent's configured `thank_you_url` survives folding a child (which
   * makes the booking multi-listing and would otherwise drop it). */
  thankYouUrl?: string | undefined;
  /** Per-(child, parent) allocation map from the fold, carried through the
   * signed metadata so the webhook can expand child bookings into per-parent
   * rows. Absent for legacy/no-parent orders. */
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
 * - Internal/unknown failure: null */
export type CheckoutSessionResult =
  | {
      sessionId: string;
      checkoutUrl: string;
    }
  | {
      error: string;
    }
  | null;

/**
 * Metadata attached to a validated payment session.
 *
 * All fields are guaranteed to be strings after extraction.
 * Empty string ("") is the canonical representation for "not provided" —
 * payment providers store metadata as string key-value pairs, so null/undefined
 * are normalized to "" by extractSessionMetadata. Domain types (e.g.
 * RegistrationIntent.date) may use null for "not provided"; conversion
 * between "" and null happens at the extraction boundary.
 *
 * This is the *logical* shape. On the Square wire, several small fields are
 * collapsed into a single packed entry to fit its 10-entry metadata cap (see
 * packMetadata); Stripe/SumUp store the fields top-level. extractSessionMetadata
 * unpacks the Square form back to this shape, so no consumer beyond that boundary
 * needs to know which form was used.
 */
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
  /** Total amount charged in smallest currency unit (cents), from the payment provider */
  amountTotal: number;
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

/**
 * Payment provider interface.
 *
 * Each provider (Stripe, Square, etc.) implements this interface.
 * Routes call these methods without knowing which provider is active.
 */
export interface PaymentProvider {
  /** The webhook event type name that indicates a completed checkout */
  readonly checkoutCompletedEventType: string;

  /**
   * Create a checkout session for one or more listings.
   * Returns a session ID and hosted checkout URL, or null on failure.
   */
  createCheckoutSession(
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult>;

  /**
   * Check if a payment has been refunded via the provider API.
   * Used to refresh refund status from the edit attendee page.
   * @param paymentReference - provider-specific payment reference
   * @returns true if the payment has been refunded
   */
  isPaymentRefunded(paymentReference: string): Promise<boolean>;

  /**
   * Refund a completed payment.
   * @param paymentReference - provider-specific payment reference (e.g. Stripe payment_intent ID)
   * @returns true if refund succeeded, false otherwise
   */
  refundPayment(paymentReference: string): Promise<boolean>;

  /** Whether incoming webhooks carry a verifiable signature. Providers that
   * sign their webhooks (Stripe, Square) set this true so the endpoint rejects
   * unsigned requests. Providers whose webhooks are unsigned (SumUp) set this
   * false and instead establish authenticity by re-fetching from the API. */
  readonly requiresWebhookSignature: boolean;

  /**
   * Resolve a validated session from a webhook event.
   * Each provider knows how to extract/fetch session data from its own
   * event structure, so the webhook handler stays provider-agnostic.
   *
   * @returns the session, "skip" if the event should be acknowledged
   *          without processing (e.g. pending payment), or null on error.
   */
  resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<ValidatedPaymentSession | "skip" | null>;

  /**
   * Retrieve and validate a completed checkout session by ID.
   * Returns the validated session or null if not found / invalid.
   */
  retrieveSession(sessionId: string): Promise<ValidatedPaymentSession | null>;

  /**
   * Set up a webhook endpoint for this provider.
   * Some providers (e.g. Stripe) support programmatic creation.
   */
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

export const getActivePaymentProvider =
  async (): Promise<PaymentProvider | null> => {
    const providerType = paymentsApi.getConfiguredProvider();
    if (!providerType) {
      logDebug("Payment", "No payment provider configured in settings");
      return null;
    }

    logDebug("Payment", `Resolving payment provider: ${providerType}`);
    return await providerLoaders[providerType]();
  };
