/**
 * Payment page templates - success, cancel, error pages
 */

import type { Attendee, Event } from "#lib/types.ts";
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
    <Layout title="Payment Successful" headExtra={thankYouUrl ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(thankYouUrl)}">` : undefined}>
        <div data-payment-result="success">
          <h1>Payment Successful!</h1>
          <div class="success">
            <p>Thank you for your payment. Your ticket has been confirmed.</p>
          </div>
          {thankYouUrl ? (
            <>
              <p>You will be redirected shortly...</p>
              <p><a href={thankYouUrl}>Click here if you are not redirected</a></p>
            </>
          ) : null}
        </div>
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
        <div data-payment-result="cancel">
          <h1>Payment Cancelled</h1>
          <p>Your payment was cancelled. Your ticket reservation has been removed.</p>
          <p><a href={ticketUrl}><i>Try again</i></a></p>
        </div>
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

/**
 * Checkout popup page - shown inside an iframe when Stripe payment is required.
 * Opens the Stripe checkout URL in a popup window since Stripe cannot run in iframes.
 */
export const checkoutPopupPage = (checkoutUrl: string): string =>
  String(
    <Layout title="Complete Payment" bodyClass="iframe">
        <div data-checkout-popup={escapeHtml(checkoutUrl)}>
          <p>Payment is processed in a new window.</p>
          <p><a href={checkoutUrl} target="_blank" rel="noopener" data-open-checkout><b>Pay Now</b></a></p>
          <div data-checkout-waiting hidden>
            <p>Completing payment in the other window...</p>
            <p><a href={checkoutUrl} target="_blank" rel="noopener"><small>Click here if the payment window didn't open</small></a></p>
          </div>
        </div>
    </Layout>
  );
