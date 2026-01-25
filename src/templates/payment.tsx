/**
 * Payment page templates - success, cancel, error pages
 */

import type { Attendee, Event } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/**
 * Payment page - redirects to Stripe Checkout
 */
export const paymentPage = (
  _event: Event,
  attendee: Attendee,
  checkoutUrl: string,
  formattedPrice: string,
): string =>
  String(
    <Layout title="Payment">
        <h1>Complete Your Payment</h1>

        <aside>
          <p><strong>Name:</strong> {attendee.name}</p>
          <p><strong>Email:</strong> {attendee.email}</p>
          <p><strong>Amount:</strong> {formattedPrice}</p>
        </aside>

        <p>Click the button below to complete your payment securely via Stripe.</p>
        <a href={checkoutUrl}><b>Pay Now</b></a>
    </Layout>
  );

/**
 * Payment success page - with optional redirect
 */
export const paymentSuccessPage = (_event: Event, thankYouUrl: string | null): string =>
  String(
    <Layout title="Payment Successful">
        <h1>Payment Successful!</h1>
        <div class="success">
          <p>Thank you for your payment. Your ticket has been confirmed.</p>
        </div>
        {thankYouUrl ? (
          <>
            <p>You will be redirected shortly...</p>
            <p><a href={thankYouUrl}>Click here if you are not redirected</a></p>
            <script>
              <Raw html={`setTimeout(function() { window.location.href = "${escapeHtml(thankYouUrl)}"; }, 3000);`} />
            </script>
          </>
        ) : null}
    </Layout>
  );

/**
 * Simple reservation success page (for free events with no thank_you_url)
 */
export const reservationSuccessPage = (): string =>
  String(
    <Layout title="Ticket Reserved">
        <h1>Ticket reserved successfully.</h1>
    </Layout>
  );

/**
 * Payment cancelled page
 */
export const paymentCancelPage = (_event: Event, ticketUrl: string): string =>
  String(
    <Layout title="Payment Cancelled">
        <h1>Payment Cancelled</h1>
        <p>Your payment was cancelled. Your ticket reservation has been removed.</p>
        <p><a href={ticketUrl}><i>Try again</i></a></p>
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
