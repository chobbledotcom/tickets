/**
 * Payment processing with Stripe and Square.
 *
 * A provider-agnostic payment interface with adapters for Stripe and Square.
 * Handles checkout sessions, webhook verification, refunds, and
 * idempotent payment processing.
 *
 * ## Provider Interface
 *
 * {@link PaymentProvider} defines the common contract:
 * - Create single and multi-event checkout sessions
 * - Verify webhook signatures
 * - Retrieve session details and process refunds
 *
 * @module
 */

export * from "#lib/booking.ts";
export * from "#lib/payment-helpers.ts";
export * from "#lib/payments.ts";
