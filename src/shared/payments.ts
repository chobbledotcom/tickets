/**
 * Payment provider abstraction layer
 *
 * Defines a provider-agnostic interface for payment operations.
 * Admins choose a provider (e.g. Stripe) in settings; routes use
 * this interface so they never depend on a specific provider.
 */

import * as v from "valibot";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { settings } from "#shared/db/settings.ts";
import { logDebug } from "#shared/logger.ts";
import type { CalcKind, ModifierTrigger } from "#shared/price-modifier.ts";
import type { ContactInfo, PaymentProviderType } from "#shared/types.ts";

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const paymentsApi = {
  getConfiguredProvider: (): PaymentProviderType | null =>
    settings.paymentProvider,
};

/** Re-export from types.ts (canonical definition) */
export type { PaymentProviderType };

/** Single item within a checkout */
export type CheckoutItem = {
  listingId: number;
  quantity: number;
  unitPrice: number;
  slug: string;
  name: string;
};

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

/**
 * Compact booking item stored in session metadata (serialized/deserialized as
 * JSON): listing id (`e`), quantity (`q`), line total in minor units (`p`).
 *
 * A top-level line also carries its edge provenance so the webhook can
 * reconstruct the line's canonical booking-tree `nodeKey` and re-check it still
 * resolves: `k` is the edge kind (`"p"` package member, `"g"` group member — see
 * signed-metadata.ts) and `r` the group id it hangs off. Both are absent on a
 * standalone line.
 */
export type BookingItem = {
  e: number;
  q: number;
  p: number;
  k?: "p" | "g";
  r?: number;
};

/** Compact modifier reference stored in session metadata: the modifier id and
 * the quantity taken. The webhook re-fetches the modifier by id and re-derives
 * its amount from the current database — provider metadata amounts are never
 * trusted. */
export type ModifierRef = { i: number; q: number };

export type TextAnswerRef = { q: number; s: number };

/** Per-listing answer references carried through a checkout, shared by the
 * booking and checkout intents. */
export type ListingAnswerRefs = {
  /** Per-listing answer IDs: maps listingId → answerIds for that listing's questions */
  listingAnswerIds?: Record<string, number[]> | undefined;
  /** Per-listing free-text string refs: maps listingId → question/string ids. */
  listingTextAnswerIds?: Record<string, TextAnswerRef[]> | undefined;
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
  /** Set when the booking is for a package group: its id, carried through the
   * signed metadata so the webhook re-derives each member's expected price from
   * the group's current `group_listings.package_price`. Absent otherwise. */
  packageGroupId?: number | undefined;
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

/** Processed booking intent extracted from payment session metadata */
export type BookingIntent = CheckoutIntentBase & {
  items: BookingItem[];
  /** Modifier references applied to this checkout, re-derived in the webhook.
   * Always present (an empty array when none applied), parsed from metadata. */
  modifiers: ModifierRef[];
  /** HMAC index of the site renewal token. The plain token never reaches the
   * payment provider, so a compromised provider cannot use it at /renew. */
  siteTokenIndex?: string | undefined;
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
export type SessionMetadata = {
  _origin: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
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
   * round-trip so the webhook can expand child bookings into per-parent rows
   * (Stage C). "" when no children were folded. */
  allocations: string;
  /** The package group's id when the booking is a package ("" otherwise), so the
   * webhook re-prices members against the current package overrides. */
  package_group_id: string;
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

/** Type guard: check if a string is a valid PaymentStatus */
export const isPaymentStatus = (s: string): s is PaymentStatus =>
  v.is(PaymentStatusSchema, s);

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

/**
 * Payment provider interface.
 *
 * Each provider (Stripe, Square, etc.) implements this interface.
 * Routes call these methods without knowing which provider is active.
 */
export interface PaymentProvider {
  /** The webhook event type name that indicates a completed checkout */
  readonly checkoutCompletedEventType: string;

  /** Whether incoming webhooks carry a verifiable signature. Providers that
   * sign their webhooks (Stripe, Square) set this true so the endpoint rejects
   * unsigned requests. Providers whose webhooks are unsigned (SumUp) set this
   * false and instead establish authenticity by re-fetching from the API. */
  readonly requiresWebhookSignature: boolean;

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
  setupWebhookEndpoint(
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult>;
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
