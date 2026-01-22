/**
 * Payment page templates - success, cancel, error pages
 */

import type { Attendee, Event } from "#lib/types.ts";
import { escapeHtml, layout } from "./layout.ts";

/**
 * Payment page - redirects to Stripe Checkout
 */
export const paymentPage = (
  event: Event,
  attendee: Attendee,
  checkoutUrl: string,
  formattedPrice: string,
): string =>
  layout(
    `Payment: ${event.name}`,
    `
    <h1>Complete Your Payment</h1>
    <p>You are purchasing a ticket for <strong>${escapeHtml(event.name)}</strong></p>

    <div style="background: #f5f5f5; padding: 1rem; border-radius: 4px; margin: 1rem 0;">
      <p><strong>Name:</strong> ${escapeHtml(attendee.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(attendee.email)}</p>
      <p><strong>Amount:</strong> ${escapeHtml(formattedPrice)}</p>
    </div>

    <p>Click the button below to complete your payment securely via Stripe.</p>
    <a href="${escapeHtml(checkoutUrl)}" style="display: inline-block; background: #0066cc; color: white; padding: 0.75rem 2rem; font-size: 1rem; border-radius: 4px; text-decoration: none;">
      Pay Now
    </a>
  `,
  );

/**
 * Payment success page
 */
export const paymentSuccessPage = (event: Event, thankYouUrl: string): string =>
  layout(
    "Payment Successful",
    `
    <h1>Payment Successful!</h1>
    <div class="success">
      <p>Thank you for your payment. Your ticket for <strong>${escapeHtml(event.name)}</strong> has been confirmed.</p>
    </div>
    <p>You will be redirected shortly...</p>
    <p><a href="${escapeHtml(thankYouUrl)}">Click here if you are not redirected</a></p>
    <script>
      setTimeout(function() {
        window.location.href = "${escapeHtml(thankYouUrl)}";
      }, 3000);
    </script>
  `,
  );

/**
 * Payment cancelled page
 */
export const paymentCancelPage = (event: Event, ticketUrl: string): string =>
  layout(
    "Payment Cancelled",
    `
    <h1>Payment Cancelled</h1>
    <p>Your payment was cancelled. Your ticket reservation for <strong>${escapeHtml(event.name)}</strong> has been removed.</p>
    <p><a href="${escapeHtml(ticketUrl)}">Try again</a></p>
  `,
  );

/**
 * Payment error page
 */
export const paymentErrorPage = (message: string): string =>
  layout(
    "Payment Error",
    `
    <h1>Payment Error</h1>
    <div class="error">
      <p>${escapeHtml(message)}</p>
    </div>
    <p><a href="/">Return to home</a></p>
  `,
  );
