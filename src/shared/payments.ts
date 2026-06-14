/**
 * Payment provider abstraction layer
 *
 * Defines a provider-agnostic interface for payment operations.
 * Admins choose a provider (e.g. Stripe) in settings; routes use
 * this interface so they never depend on a specific provider.
 */

import { settings } from "#shared/db/settings.ts";
import { logDebug } from "#shared/logger.ts";
import {
  type ContactInfo,
  createTypeGuard,
  type PaymentProviderType,
} from "#shared/types.ts";

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const paymentsApi = {
  getConfiguredProvider: (): PaymentProviderType | null =>
    settings.paymentProvider,
};

/** Re-export from types.ts (canonical definition) */
export type { PaymentProviderType };

/** Single item within a checkout */
export type CheckoutItem = {
  eventId: number;
  quantity: number;
  unitPrice: number;
  slug: string;
  name: string;
};

/** Compact booking item stored in session metadata (serialized/deserialized as JSON) */
export type BookingItem = { e: number; q: number; p: number };

/** Processed booking intent extracted from payment session metadata */
export type BookingIntent = ContactInfo & {
  date: string | null;
  items: BookingItem[];
  /** Per-event answer IDs: maps eventId → answerIds for that event's questions */
  eventAnswerIds?: Record<string, number[]>;
  /** HMAC index of the site renewal token. The plain token never reaches the
   * payment provider, so a compromised provider cannot use it at /renew. */
  siteTokenIndex?: string;
};

/** Registration intent for checkout (one or more events) */
export type CheckoutIntent = ContactInfo & {
  date: string | null;
  items: CheckoutItem[];
  /** Per-event answer IDs: maps eventId → answerIds for that event's questions */
  eventAnswerIds?: Record<string, number[]>;
  /** Plain site renewal token from /renew. Hashed before storage in provider
   * metadata; never stored at the provider in plaintext. */
  siteToken?: string;
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
  site_token_index: string;
};

/** Valid payment status values. "failed" is a terminal non-payment (declined
 * or expired checkout) — distinct from "unpaid", which may still complete. */
export type PaymentStatus =
  | "paid"
  | "unpaid"
  | "no_payment_required"
  | "failed";

/** Runtime array of valid payment status values */
const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "paid",
  "unpaid",
  "no_payment_required",
  "failed",
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
  /** The webhook event type name that indicates a completed checkout */
  readonly checkoutCompletedEventType: string;

  /** Whether incoming webhooks carry a verifiable signature. Providers that
   * sign their webhooks (Stripe, Square) set this true so the endpoint rejects
   * unsigned requests. Providers whose webhooks are unsigned (SumUp) set this
   * false and instead establish authenticity by re-fetching from the API. */
  readonly requiresWebhookSignature: boolean;

  /**
   * Create a checkout session for one or more events.
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
    event: WebhookEvent,
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
