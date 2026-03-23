/**
 * Payment page templates - success, cancel, error pages
 */

import { t } from "#i18n";
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
    <Layout title={t("payment.title")}>
      <h1>{t("payment.complete_your_payment")}</h1>

      <aside>
        <p>
          <strong>{t("payment.name_label")}</strong> {attendee.name}
        </p>
        <p>
          <strong>{t("payment.email_label")}</strong> {attendee.email}
        </p>
        <p>
          <strong>{t("payment.amount_label")}</strong> {formattedPrice}
        </p>
      </aside>

      <p>{t("payment.stripe_instructions")}</p>
      <a href={checkoutUrl}>
        <b>{t("payment.pay_now")}</b>
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
  const title = paid
    ? t("payment.success.title_paid")
    : t("payment.success.title_free");
  const heading = paid
    ? t("payment.success.heading_paid")
    : t("payment.success.heading_free");
  return String(
    <Layout
      title={title}
      headExtra={
        thankYouUrl
          ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(thankYouUrl)}">`
          : undefined
      }
      bodyClass={inIframe ? "iframe" : undefined}
    >
      <div
        data-payment-result={paid ? "success" : undefined}
        data-scroll-into-view={inIframe || undefined}
      >
        <h1>{heading}</h1>
        {paid ? (
          <div class="success">
            <p>{t("payment.success.thank_you")}</p>
          </div>
        ) : null}
        {fromEmail ? (
          <p>
            <small>
              <i>{t("payment.success.email_notice", { fromEmail })}</i>
            </small>
          </p>
        ) : null}
        {ticketUrl ? (
          <p>
            <a href={ticketUrl} target="_blank" rel="noopener">
              {ticketUrl.split("+").length > 1
                ? t("payment.success.view_tickets")
                : t("payment.success.view_ticket")}
            </a>
          </p>
        ) : null}
        {thankYouUrl ? (
          <>
            <p>{t("payment.success.redirecting")}</p>
            <p>
              <a href={thankYouUrl}>{t("payment.success.redirect_link")}</a>
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
    <Layout title={t("payment.cancel.title")}>
      <div data-payment-result="cancel">
        <h1>{t("payment.cancel.heading")}</h1>
        <p>{t("payment.cancel.message")}</p>
        <p>
          <a href={ticketUrl}>
            <i>{t("payment.cancel.try_again")}</i>
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
    <Layout title={t("payment.error.title")}>
      <h1>{t("payment.error.heading")}</h1>
      <div class="error">
        <p>{message}</p>
      </div>
      <p>
        <a href="/">{t("payment.error.return_home")}</a>
      </p>
    </Layout>,
  );

/**
 * Checkout popup page - shown inside an iframe when Stripe payment is required.
 * Opens the Stripe checkout URL in a popup window since Stripe cannot run in iframes.
 */
export const checkoutPopupPage = (checkoutUrl: string): string =>
  String(
    <Layout title={t("payment.popup.title")} bodyClass="iframe">
      <div data-checkout-popup={escapeHtml(checkoutUrl)} data-scroll-into-view>
        <p>{t("payment.popup.instructions")}</p>
        <p>
          <a
            href={checkoutUrl}
            target="_blank"
            data-open-checkout
            rel="noopener"
          >
            <b>{t("payment.popup.pay_now")}</b>
          </a>
        </p>
        <div data-checkout-waiting hidden>
          <p>{t("payment.popup.waiting")}</p>
          <p>
            <a href={checkoutUrl} target="_blank" rel="noopener">
              <small>{t("payment.popup.window_hint")}</small>
            </a>
          </p>
        </div>
      </div>
    </Layout>,
  );
