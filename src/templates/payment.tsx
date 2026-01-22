/**
 * Payment page templates - success, cancel, error pages
 */

import type { Attendee, Event } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { escapeHtml, Layout } from "./layout.tsx";

/**
 * Payment page - redirects to Stripe Checkout
 */
export const paymentPage = (
  event: Event,
  attendee: Attendee,
  checkoutUrl: string,
  formattedPrice: string,
): string =>
  String(
    <Layout title={`Payment: ${event.name}`}>
      <h1>Complete Your Payment</h1>
      <p>You are purchasing a ticket for <strong>{event.name}</strong></p>

      <div style="background: #f5f5f5; padding: 1rem; border-radius: 4px; margin: 1rem 0;">
        <p><strong>Name:</strong> {attendee.name}</p>
        <p><strong>Email:</strong> {attendee.email}</p>
        <p><strong>Amount:</strong> {formattedPrice}</p>
      </div>

      <p>Click the button below to complete your payment securely via Stripe.</p>
      <a
        href={checkoutUrl}
        style="display: inline-block; background: #0066cc; color: white; padding: 0.75rem 2rem; font-size: 1rem; border-radius: 4px; text-decoration: none;"
      >
        Pay Now
      </a>
    </Layout>
  );

/**
 * Payment success page
 */
export const paymentSuccessPage = (event: Event, thankYouUrl: string): string =>
  String(
    <Layout title="Payment Successful">
      <h1>Payment Successful!</h1>
      <div class="success">
        <p>Thank you for your payment. Your ticket for <strong>{event.name}</strong> has been confirmed.</p>
      </div>
      <p>You will be redirected shortly...</p>
      <p><a href={thankYouUrl}>Click here if you are not redirected</a></p>
      <script>
        <Raw html={`setTimeout(function() { window.location.href = "${escapeHtml(thankYouUrl)}"; }, 3000);`} />
      </script>
    </Layout>
  );

/**
 * Payment cancelled page
 */
export const paymentCancelPage = (event: Event, ticketUrl: string): string =>
  String(
    <Layout title="Payment Cancelled">
      <h1>Payment Cancelled</h1>
      <p>Your payment was cancelled. Your ticket reservation for <strong>{event.name}</strong> has been removed.</p>
      <p><a href={ticketUrl}>Try again</a></p>
    </Layout>
  );

/**
 * Payment error page
 */
export const paymentErrorPage = (message: string): string =>
  String(
    <Layout title="Payment Error">
      <h1>Payment Error</h1>
      <div class="error">
        <p>{message}</p>
      </div>
      <p><a href="/">Return to home</a></p>
    </Layout>
  );
