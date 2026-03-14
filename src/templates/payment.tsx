/**
 * Payment page templates - success, cancel, error pages
 */

import { getIframeMode } from "#lib/iframe.ts";
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
  const title = paid ? "Payment Successful" : "Ticket Reserved";
  const heading = paid
    ? "Payment Successful!"
    : "Ticket reserved successfully.";
  return String(
    <Layout
      title={title}
      headExtra={thankYouUrl
        ? `<meta http-equiv="refresh" content="3;url=${
          escapeHtml(thankYouUrl)
        }">`
        : undefined}
      bodyClass={inIframe ? "iframe" : undefined}
    >
      <div
        data-payment-result={paid ? "success" : undefined}
        data-scroll-into-view={inIframe || undefined}
      >
        <h1>{heading}</h1>
        {paid
          ? (
            <div class="success">
              <p>Thank you for your payment. Your ticket has been confirmed.</p>
            </div>
          )
          : null}
        {fromEmail
          ? (
            <p>
              <small>
                <i>
                  Your ticket will be sent from {fromEmail}{" "}
                  &mdash; please check your Junk/Spam folder.
                </i>
              </small>
            </p>
          )
          : null}
        {ticketUrl
          ? (
            <p>
              <a href={ticketUrl} target="_blank">
                Click here to view your tickets
              </a>
            </p>
          )
          : null}
        {thankYouUrl
          ? (
            <>
              <p>You will be redirected shortly...</p>
              <p>
                <a href={thankYouUrl}>Click here if you are not redirected</a>
              </p>
            </>
          )
          : null}
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
      <div class="error">
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
    <Layout title="Complete Payment" bodyClass="iframe">
      <div data-checkout-popup={escapeHtml(checkoutUrl)} data-scroll-into-view>
        <p>Payment is processed in a new window.</p>
        <p>
          <a href={checkoutUrl} target="_blank" data-open-checkout>
            <b>Pay Now</b>
          </a>
        </p>
        <div data-checkout-waiting hidden>
          <p>Completing payment in the other window...</p>
          <p>
            <a href={checkoutUrl} target="_blank">
              <small>Click here if the payment window didn't open</small>
            </a>
          </p>
        </div>
      </div>
    </Layout>,
  );
