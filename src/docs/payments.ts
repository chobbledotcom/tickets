/**
 * Payment processing with Stripe, Square, and SumUp.
 *
 * A provider-agnostic payment interface with adapters for all three providers.
 * Handles checkout sessions, webhook verification, refunds, and
 * idempotent payment processing.
 *
 * Checkout uses one tax assessment for the full booking. Added VAT raises the
 * total. Included VAT keeps the listed total. Booking fees stay outside VAT.
 * Percentage deposits use the total with tax. Fixed deposits keep their
 * stated amount. The unpaid assessment remains owed.
 * Signed metadata retains the charged tax policy. Later settings changes do not
 * change a checkout in progress. Old sessions without that field use No tax.
 * Balance payments settle saved debt without another tax assessment.
 * An attendee save applies current settings to the original price basis.
 * It adds correction entries and a new assessment revision. It never charges
 * or refunds money. Refunds reverse all physical events in the assessment chain.
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
export * from "#shared/provider-line-items.ts";
