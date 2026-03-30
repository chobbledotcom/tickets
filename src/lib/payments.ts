/**
 * Payment provider abstraction layer
 *
 * Defines a provider-agnostic interface for payment operations.
 * Admins choose a provider (e.g. Stripe) in settings; routes use
 * this interface so they never depend on a specific provider.
 */

import { settings } from "#lib/db/settings.ts";
import { logDebug } from "#lib/logger.ts";
import {
  type ContactInfo,
  createTypeGuard,
  type Event,
  type PaymentProviderType,
} from "#lib/types.ts";

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const paymentsApi = {
  getConfiguredProvider: (): PaymentProviderType | null =>
    settings.paymentProvider,
};

/** Re-export from types.ts (canonical definition) */
export type { PaymentProviderType };

/** Registration intent for a single event checkout */
export type RegistrationIntent = ContactInfo & {
  eventId: number;
  quantity: number;
  /** Selected date for daily events; null means no date selected */
  date: string | null;
  /** Custom unit price (minor units) when can_pay_more is enabled; overrides event.unit_price */
  customUnitPrice?: number;
  /** Custom question answer IDs selected during checkout */
  answerIds?: number[];
};

/** Single item within a multi-event checkout */
export type CartItem = {
  eventId: number;
  quantity: number;
  unitPrice: number;
  slug: string;
  name: string;
};

/** Compact booking item stored in session metadata (serialized/deserialized as JSON) */
export type BookingItem = { e: number; q: number; p: number };

/** Registration intent for multi-event checkout */
export type CartIntent = ContactInfo & {
  date: string | null;
  items: CartItem[];
  /** Per-event answer IDs: maps eventId → answerIds for that event's questions */
  eventAnswerIds?: Record<string, number[]>;
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
  answer_ids: string;
};

/** Valid payment status values */
export type PaymentStatus = "paid" | "unpaid" | "no_payment_required";

/** Runtime array of valid payment status values */
const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "paid",
  "unpaid",
  "no_payment_required",
];

/** Type guard: check if a string is a valid PaymentStatus */
export const isPaymentStatus: (s: string) => s is PaymentStatus =
  createTypeGuard(PAYMENT_STATUSES);

/** A validated payment session returned after checkout completion */
export type ValidatedPaymentSession = {
  id: string;
  paymentStatus: PaymentStatus;
  paymentReference: string;
  /** Total amount charged in smallest currency unit (cents), from the payment provider */
  amountTotal: number;
  metadata: SessionMetadata;
};

/** Result of webhook signature verification */
export type WebhookVerifyResult =
  | { valid: true; event: WebhookEvent }
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
  /** Provider identifier */
  readonly type: PaymentProviderType;

  /**
   * Create a checkout session for a single-event purchase.
   * Returns a session ID and hosted checkout URL, or null on failure.
   */
  createCheckoutSession(
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult>;

  /**
   * Create a checkout session for a multi-event purchase.
   * Returns a session ID and hosted checkout URL, or null on failure.
   */
  createCartCheckoutSession(
    intent: CartIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult>;

  /**
   * Retrieve and validate a completed checkout session by ID.
   * Returns the validated session or null if not found / invalid.
   */
  retrieveSession(sessionId: string): Promise<ValidatedPaymentSession | null>;

  /**
   * Verify a webhook request's signature and parse the event payload.
   * @param webhookUrl - The webhook endpoint URL derived from the incoming request
   * @param payloadBytes - Raw body bytes from request.arrayBuffer()
   */
  verifyWebhookSignature(
    payload: string,
    signature: string,
    webhookUrl: string,
    payloadBytes: Uint8Array,
  ): Promise<WebhookVerifyResult>;

  /**
   * Refund a completed payment.
   * @param paymentReference - provider-specific payment reference (e.g. Stripe payment_intent ID)
   * @returns true if refund succeeded, false otherwise
   */
  refundPayment(paymentReference: string): Promise<boolean>;

  /**
   * Set up a webhook endpoint for this provider.
   * Some providers (e.g. Stripe) support programmatic creation.
   */
  setupWebhookEndpoint(
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult>;

  /**
   * Check if a payment has been refunded via the provider API.
   * Used to refresh refund status from the edit attendee page.
   * @param paymentReference - provider-specific payment reference
   * @returns true if the payment has been refunded
   */
  isPaymentRefunded(paymentReference: string): Promise<boolean>;

  /** The webhook event type name that indicates a completed checkout */
  readonly checkoutCompletedEventType: string;

  /**
   * Resolve a validated session from a webhook event.
   * Each provider knows how to extract/fetch session data from its own
   * event structure, so the webhook handler stays provider-agnostic.
   *
   * @returns the session, "skip" if the event should be acknowledged
   *          without processing (e.g. pending payment), or null on error.
   */
  resolveWebhookSession(
    event: WebhookEvent,
  ): Promise<ValidatedPaymentSession | "skip" | null>;
}

/**
 * Resolve the active payment provider based on admin settings.
 * Lazy-loads the provider module to avoid importing unused SDKs.
 * Returns null if no provider is configured.
 */
export const getActivePaymentProvider =
  async (): Promise<PaymentProvider | null> => {
    const providerType = paymentsApi.getConfiguredProvider();
    if (!providerType) {
      logDebug("Payment", "No payment provider configured in settings");
      return null;
    }

    logDebug("Payment", `Resolving payment provider: ${providerType}`);

    if (providerType === "stripe") {
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      return stripePaymentProvider;
    }

    const { squarePaymentProvider } = await import("#lib/square-provider.ts");
    return squarePaymentProvider;
  };
