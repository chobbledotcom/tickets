/**
 * Payment page templates - success, cancel, error pages
 */

import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import type { StaffDiagnostics } from "#routes/payment-response.ts";
import { appendIframeParam, getIframeMode } from "#shared/iframe.ts";
import { ActionButton, Icon } from "#templates/components/actions.tsx";
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

/** The action row the payment pages share: one outline link with a rotate
 * icon that starts their respective step over — the cancel page's "Try
 * again" and the waiting page's "Check again". */
const outlineActionRow = (href: string, label: string): JSX.Element => (
  <p>
    <ActionButton href={href} icon="rotate-ccw" variant="outline">
      {label}
    </ActionButton>
  </p>
);

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
        {ticketUrl ? (
          outlineActionRow(ticketUrl, t("payment.cancel.try_again"))
        ) : (
          <p>
            <ActionButton href="/" variant="outline">
              {t("payment.cancel.return_home")}
            </ActionButton>
          </p>
        )}
      </div>
    </Layout>,
  );

/** How often the waiting page reloads itself while a payment settles. */
export const WAITING_PAGE_RELOAD_SECONDS = 30;

/** How many timed reloads one visit may spend, so a tab nobody watches stops
 * costing the provider and the database reads after a few minutes. */
export const WAITING_PAGE_RELOAD_LIMIT = 10;

/** Whether the waiting page still reloads itself after this many reloads.
 * The ninth reload schedules the tenth; the tenth renders the page without a
 * timer, leaving only the "Check again" link. */
export const waitingPageStillReloads = (reloadsSoFar: number): boolean =>
  reloadsSoFar < WAITING_PAGE_RELOAD_LIMIT;

/** The owner's diagnostics panel, shared by the waiting and error pages.
 * Renders nothing when no facts arrived. */
const StaffDiagnosticsDetails = ({
  diagnostics,
}: {
  diagnostics: StaffDiagnostics | undefined;
}): JSX.Element | null =>
  diagnostics === undefined ? null : (
    <details class="staff-diagnostics">
      <summary>{t("payment.staff.heading")}</summary>
      <LabelledParas items={diagnostics.rows} />
      <p>{t("payment.staff.reasons_heading")}</p>
      <ul>
        {diagnostics.reasons.map((reason) => (
          <li>{reason}</li>
        ))}
      </ul>
    </details>
  );

/**
 * Waiting page for a return that landed while the provider had not confirmed
 * the payment — a normal state when a hosted checkout redirects before its
 * transaction settles. No `data-payment-result` attribute: the popup
 * notifier would tell the embedding page the payment was cancelled, which
 * could push a buyer who has paid to pay twice.
 */
export const paymentWaitingPage = ({
  checkAgainHref,
  diagnostics,
  refreshUrl,
}: {
  /** The same return URL, so one click re-asks the provider. */
  checkAgainHref: string;
  /** Owner-only facts, rendered for an owner session only. */
  diagnostics: StaffDiagnostics | undefined;
  /** The return URL with the next reload count, or null when the window is
   * over and only the link remains. */
  refreshUrl: string | null;
}): string =>
  String(
    <Layout
      {...(refreshUrl
        ? {
            headExtra: `<meta http-equiv="refresh" content="${WAITING_PAGE_RELOAD_SECONDS};url=${escapeHtml(refreshUrl)}">`,
          }
        : {})}
      title={t("payment.pending.title")}
    >
      <div class="prose">
        <h1>{t("payment.pending.heading")}</h1>
        <p>{t("payment.pending.message")}</p>
        {refreshUrl ? <p>{t("payment.pending.auto_check")}</p> : null}
      </div>
      <StaffDiagnosticsDetails diagnostics={diagnostics} />
      {outlineActionRow(checkAgainHref, t("payment.pending.check_again"))}
    </Layout>,
  );

/**
 * Payment error page. When the caller handed over staff diagnostics, an
 * owner reading the page can open them beside the refusal.
 */
export const paymentErrorPage = (
  message: string,
  diagnostics?: StaffDiagnostics,
): string =>
  simplePublicPage(
    t("payment.error.title"),
    t("payment.error.heading"),
  )(
    <>
      <ErrorAlert>
        <p>{message}</p>
      </ErrorAlert>
      <StaffDiagnosticsDetails diagnostics={diagnostics} />
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
      <div
        data-checkout-popup={escapeHtml(checkoutUrl)}
        data-scroll-into-view
        /* The popup page only exists in iframe mode, so the confirmation the
           client navigates the iframe to must keep ?iframe=true — without it
           the normal header would return after payment. */
        data-success-href={appendIframeParam("/ticket/reserved")}
      >
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
