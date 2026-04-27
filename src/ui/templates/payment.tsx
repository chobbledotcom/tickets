/**
 * Payment page templates - success, cancel, error pages
 */

import { getIframeMode } from "#shared/iframe.ts";
import type { Attendee, Event } from "#shared/types.ts";
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
        <p>
          <strong>Name:</strong> {attendee.name}
        </p>
        <p>
          <strong>Email:</strong> {attendee.email}
        </p>
        <p>
          <strong>Amount:</strong> {formattedPrice}
        </p>
      </aside>

      <p>
        Click the button below to complete your payment securely via Stripe.
      </p>
      <a href={checkoutUrl}>
        <b>Pay Now</b>
      </a>
    </Layout>,
  );

/**
 * Success page - shown after payment or free reservation
 */
export const successPage = ({
  ticketUrl,
  thankYouUrl = "",
  paid = false,
  fromEmail = "",
}: {
  ticketUrl: string | null;
  thankYouUrl?: string;
  paid?: boolean;
  fromEmail?: string;
}): string => {
  const inIframe = getIframeMode();
  return String(
    <Layout
      bodyClass={inIframe ? "iframe" : undefined}
      headExtra={
        thankYouUrl
          ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(
              thankYouUrl,
            )}">`
          : undefined
      }
      title="Order Successful"
    >
      <div
        data-payment-result={paid ? "success" : undefined}
        data-scroll-into-view={inIframe || undefined}
      >
        <h1>Thank you for your order.</h1>
        {fromEmail ? (
          <p>
            <small>
              <i>
                Your ticket will be sent from {fromEmail} &mdash; please check
                your Junk/Spam folder.
              </i>
            </small>
          </p>
        ) : null}
        {ticketUrl ? (
          <p>
            <a href={ticketUrl} rel="noopener" target="_blank">
              Click here to view your ticket
            </a>
          </p>
        ) : null}
        {thankYouUrl ? (
          <>
            <p>You will be redirected shortly...</p>
            <p>
              <a href={thankYouUrl}>Click here if you are not redirected</a>
            </p>
          </>
        ) : null}
      </div>
    </Layout>,
  );
};

/**
 * Payment cancelled page
 */
export const paymentCancelPage = (_event: Event, ticketUrl: string): string =>
  String(
    <Layout title="Payment Cancelled">
      <div data-payment-result="cancel">
        <h1>Payment Cancelled</h1>
        <p>
          Your payment was cancelled. Your ticket reservation has been removed.
        </p>
        <p>
          <a href={ticketUrl}>
            <i>Try again</i>
          </a>
        </p>
      </div>
    </Layout>,
  );

/**
 * Payment error page
 */
export const paymentErrorPage = (message: string): string =>
  String(
    <Layout title="Payment Error">
      <h1>Payment Error</h1>
      <div class="error" role="alert">
        <p>{message}</p>
      </div>
      <p>
        <a href="/">Return to home</a>
      </p>
    </Layout>,
  );

/**
 * Checkout popup page - shown inside an iframe when Stripe payment is required.
 * Opens the Stripe checkout URL in a popup window since Stripe cannot run in iframes.
 */
export const checkoutPopupPage = (checkoutUrl: string): string =>
  String(
    <Layout bodyClass="iframe" title="Complete Payment">
      <div data-checkout-popup={escapeHtml(checkoutUrl)} data-scroll-into-view>
        <p>Payment is processed in a new window.</p>
        <p>
          <a
            data-open-checkout
            href={checkoutUrl}
            rel="noopener"
            target="_blank"
          >
            <b>Pay Now</b>
          </a>
        </p>
        <div data-checkout-waiting hidden>
          <p>Completing payment in the other window...</p>
          <p>
            <a href={checkoutUrl} rel="noopener" target="_blank">
              <small>Click here if the payment window didn't open</small>
            </a>
          </p>
        </div>
      </div>
    </Layout>,
  );
