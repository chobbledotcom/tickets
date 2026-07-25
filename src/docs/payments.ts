/**
 * Payment processing with Stripe, Square, and SumUp.
 *
 * A provider-agnostic payment interface with adapters for all three providers.
 * Handles checkout sessions, webhook verification, refunds, and
 * idempotent payment processing.
 *
 * ## Provider Interface
 *
 * {@link PaymentProvider} defines the common contract:
 * - Create single and multi-listing checkout sessions
 * - Validate incoming webhooks using each provider's checks
 * - Retrieve session details and process refunds
 *
 * @module
 */

export * from "#shared/booking.ts";
export * from "#shared/payment-helpers.ts";
export * from "#shared/payments.ts";
