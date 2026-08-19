/**
 * Payment page templates - success, cancel, error pages
 */

import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { getIframeMode } from "#shared/iframe.ts";
import { Icon } from "#templates/components/actions.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";
import { LabelledParas } from "#templates/components/labelled-para.tsx";
import { NewTabLink } from "#templates/components/new-tab-link.tsx";
import { Layout } from "#templates/layout.tsx";
import { simplePublicPage } from "#templates/public/prose-page.tsx";
import type { Attendee, Listing } from "#types";

/**
 * Payment page - redirects to Stripe Checkout
 */
export const paymentPage = (
  _listing: Listing,
  attendee: Attendee,
  checkoutUrl: string,
  formattedPrice: string,
): string =>
  String(
    <Layout title={t("payment.title")}>
      <h1>{t("payment.complete_your_payment")}</h1>
      <aside>
        <LabelledParas
          items={[
            { label: t("payment.name_label"), value: attendee.name },
            { label: t("payment.email_label"), value: attendee.email },
            { label: t("payment.amount_label"), value: formattedPrice },
          ]}
        />
      </aside>
      <p>{t("payment.stripe_instructions")}</p>
      <a class="btn" href={checkoutUrl}>
        <Icon name="credit-card" />
        <span>{t("payment.pay_now")}</span>
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
      {...(inIframe ? { bodyClass: "iframe" } : {})}
      {...(thankYouUrl
        ? {
            headExtra: `<meta http-equiv="refresh" content="3;url=${escapeHtml(
              thankYouUrl,
            )}">`,
          }
        : {})}
      title={t("payment.success.title")}
    >
      <div
        data-payment-result={paid ? "success" : undefined}
        data-scroll-into-view={inIframe || undefined}
      >
        <div class="prose">
          <h1>{t("payment.success.heading")}</h1>
          {fromEmail ? (
            <p>
              <small>
                <i>{t("payment.success.email_notice", { fromEmail })}</i>
              </small>
            </p>
          ) : null}
        </div>
        {ticketUrl ? (
          <p>
            <NewTabLink href={ticketUrl}>
              {t(
                ticketUrl.includes("+")
                  ? "payment.success.view_tickets"
                  : "payment.success.view_ticket",
              )}
            </NewTabLink>
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
export const paymentCancelPage = (
  _listing: Listing,
  ticketUrl: string | null,
): string =>
  String(
    <Layout title={t("payment.cancel.title")}>
      <div data-payment-result="cancel">
        <div class="prose">
          <h1>{t("payment.cancel.heading")}</h1>
          <p>{t("payment.cancel.message")}</p>
        </div>
        {/* No retry link when the listing has lost its own booking page mid-
            checkout (now a non-standalone child or hidden package member): the
            /ticket/<slug> link would 404. Offer a way home instead. */}
        <p>
          {ticketUrl ? (
            <a class="btn outline" href={ticketUrl}>
              <Icon name="rotate-ccw" />
              <span>{t("payment.cancel.try_again")}</span>
            </a>
          ) : (
            <a class="btn outline" href="/">
              <span>{t("payment.cancel.return_home")}</span>
            </a>
          )}
        </p>
      </div>
    </Layout>,
  );

/**
 * Payment error page
 */
export const paymentErrorPage = (message: string): string =>
  simplePublicPage(
    t("payment.error.title"),
    t("payment.error.heading"),
  )(
    <>
      <ErrorAlert>
        <p>{message}</p>
      </ErrorAlert>
      <p>
        <a href="/">{t("payment.error.return_home")}</a>
      </p>
    </>,
  );

/**
 * Checkout popup page - shown inside an iframe when Stripe payment is required.
 * Opens the Stripe checkout URL in a popup window since Stripe cannot run in iframes.
 */
export const checkoutPopupPage = (checkoutUrl: string): string =>
  String(
    <Layout bodyClass="iframe" title={t("payment.popup.title")}>
      <div data-checkout-popup={escapeHtml(checkoutUrl)} data-scroll-into-view>
        <p>{t("payment.popup.instructions")}</p>
        <p>
          <a
            class="btn"
            data-open-checkout
            href={checkoutUrl}
            rel="noopener"
            target="_blank"
          >
            <Icon name="credit-card" />
            <span>{t("payment.popup.pay_now")}</span>
          </a>
        </p>
        <div data-checkout-waiting hidden>
          <p>{t("payment.popup.waiting")}</p>
          <p>
            <NewTabLink href={checkoutUrl}>
              <small>{t("payment.popup.window_hint")}</small>
            </NewTabLink>
          </p>
        </div>
      </div>
    </Layout>,
  );
