/**
 * Webhook routes - payment callbacks and provider webhooks
 *
 * Payment flow (race-condition safe with two-phase locking):
 * 1. User submits form -> checkout session created with intent metadata (no attendee yet)
 * 2. User pays -> redirected to /payment/success OR webhook fires
 * 3. First handler reserves session (DB lock), creates attendee, finalizes lock
 * 4. Subsequent handlers see reserved/finalized session and return existing attendee
 * 5. If capacity exceeded after payment, auto-refund and show error
 *
 * Security:
 * - Webhooks are verified using provider-specific signature verification
 * - Session ID alone cannot create attendees - provider API confirms payment status
 * - Two-phase locking prevents duplicate attendee creation from race conditions
 */

import { unique } from "#fp";
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import {
  paymentSessionErrorLogger,
  validatePaidSession,
} from "#routes/api/payment-processing/classify.ts";
import { formatPaymentError } from "#routes/api/payment-processing/format-error.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  answerRejectedSession,
  failureDetail,
} from "#routes/api/payment-processing/refunds.ts";
import { handlePaymentWebhook } from "#routes/api/payment-webhook.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
/* jscpd:ignore-start — coincidental import order shared with checkin.ts */
import {
  parseTokens,
  verifyTokensWithRealLine,
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
/* jscpd:ignore-end */
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { clearSessionTokens } from "#shared/db/processed-payments.ts";
import { t } from "#shared/i18n.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { isSessionRejection } from "#shared/payment/validated-session.ts";
import { getExistingPaymentAttempt } from "#shared/payment-attempt.ts";
import { successPage } from "#templates/payment.tsx";

/** Render the paid success page, drawing the sender email from settings. Shared
 * by the direct-render redirect path and the verified-tokens render path. */
const renderPaidSuccessPage = async (
  thankYouUrl: string,
  ticketUrl: string,
): Promise<Response> => {
  const fromEmail = await getFromEmailIfConfigured();
  return htmlResponse(
    successPage({ fromEmail, paid: true, thankYouUrl, ticketUrl }),
  );
};

/** The `session_id` query param of a payment callback, or "" when absent.
 * Shared by every callback handler that reads it. */
const paymentSessionId = (request: Request): string =>
  getSearchParam(request, "session_id");

/** The payment session id from a success redirect: Stripe's `session_id`, or
 * Square's `orderId` when `session_id` is absent. "" when neither is present. */
const redirectSessionId = (request: Request): string =>
  paymentSessionId(request) || getSearchParam(request, "orderId");

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = paymentSessionId(request);
    if (!sessionId) {
      logError({
        code: ErrorCode.PAYMENT_SESSION,
        detail: "Payment callback missing session_id parameter",
      });
    }
    return sessionId
      ? handler(sessionId)
      : Promise.resolve(paymentErrorResponse("Invalid payment callback"));
  };

/**
 * Process session_id param: validate, create attendee, redirect with tokens.
 */
/** The thank-you redirect for a single-listing purchase, or "" when there is no
 * URL — suppressed entirely when the listing is a HIDDEN package's member. Its
 * `thank_you_url` would meta-refresh the success page to a listing the package
 * concealed, exposing it to a buyer who only ever saw the package name (the same
 * privacy invariant the signed-intent/free-redirect guard upholds, here for the
 * paid single-member fallback both success render paths share). */
const singleListingThankYou = async (listingId: number): Promise<string> => {
  if ((await getHiddenPackageMemberIds([listingId])).size > 0) return "";
  const listing = await getListingWithCount(listingId);
  return listing?.thank_you_url.trim() ?? "";
};

const processSessionAndRedirect = async (
  sessionId: string,
): Promise<Response> => {
  const attempt = await getExistingPaymentAttempt();
  if (!attempt) {
    paymentSessionErrorLogger("redirect")(
      `No payment provider configured (session=${sessionId})`,
    );
    return paymentErrorResponse("Payment provider not configured");
  }
  const validation = await validatePaidSession(attempt, sessionId);
  if (!validation.ok) return validation.response;

  // A parent booking carries an explicit thank-you URL through its signed
  // metadata so folding a child (which makes the order multi-listing) doesn't
  // drop the parent's configured redirect. The token-derive render keys off the
  // booked listing ids, so it can't recover that URL once >1 listing is booked
  // — that path renders the success page directly here (below), where the
  // verified intent still holds it, rather than redirecting to the token path.
  const explicitThankYou = validation.data.intent.thankYouUrl ?? "";

  // The ticket token is finalized atomically with the booking, so a racing
  // webhook and redirect always resolve the same attendee and token.
  const result = await processPaymentSession(
    attempt,
    sessionId,
    validation.data,
  );

  if (!result.success) {
    // Log once at the redirect boundary
    const listingId = validation.data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[redirect] ${failureDetail(result)}`,
      listingId,
    });
    return paymentErrorResponse(formatPaymentError(result), result.status);
  }

  // Direct-render path: render the success page here (with the ticket URL drawn
  // from the persisted/just-created tokens) so the parent's thank-you URL is
  // honoured and a reload still finds the token in the DB.
  if (explicitThankYou && result.ticketTokens.length > 0) {
    return renderPaidSuccessPage(
      explicitThankYou,
      `/t/${result.ticketTokens.join("+")}`,
    );
  }

  // Redirect path: the tokens go in the URL, so clear any a racing webhook stored
  // (consumed now via the redirect URL), then redirect.
  // encodeURIComponent preserves + as %2B so URLSearchParams.get() decodes it back correctly
  if (result.ticketTokens.length > 0) {
    await clearSessionTokens(sessionId);
    return redirectResponse(
      `/payment/success?tokens=${encodeURIComponent(
        result.ticketTokens.join("+"),
      )}`,
    );
  }

  // Already-processed session (no tokens available) - render directly. An
  // explicit (parent) thank-you URL from the intent wins; otherwise resolve the
  // listing lazily (the only place a thank-you URL is needed) so the webhook
  // path never loads it; a since-deleted listing simply yields no URL.
  let thankYouUrl = explicitThankYou;
  if (!thankYouUrl && validation.data.intent.items.length === 1) {
    thankYouUrl = await singleListingThankYou(result.listingId);
  }
  return htmlResponse(
    successPage({ paid: true, thankYouUrl, ticketUrl: null }),
  );
};

/**
 * Render success page from verified tokens param.
 */
const renderSuccessFromTokens = async (
  tokensParam: string,
): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  // Only tokens with a real (quantity > 0) line are valid: an all-ghost token's
  // /t link would 404, and a ghost line must not inflate the single-listing
  // thank-you check.
  const { verifiedTokens, listingIds } = await verifyTokensWithRealLine(tokens);

  if (verifiedTokens.length === 0) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const ticketUrl = `/t/${verifiedTokens.join("+")}`;

  // Only use thank_you_url for single-listing purchases — and never for a hidden
  // package's sole member, whose URL would reveal the listing it concealed.
  const uniqueListingIds = unique(listingIds);
  const thankYouUrl =
    uniqueListingIds.length === 1
      ? await singleListingThankYou(uniqueListingIds[0]!)
      : "";

  return renderPaidSuccessPage(thankYouUrl, ticketUrl);
};

/**
 * Handle GET /payment/success (redirect after successful payment)
 *
 * Two-phase flow:
 * 1. With session_id: process payment, create attendee, redirect with tokens
 * 2. With tokens: verify tokens against DB, render success page with ticket link
 */
const handlePaymentSuccess = (request: Request): Promise<Response> => {
  // Stripe uses session_id via {CHECKOUT_SESSION_ID} template variable;
  // Square appends orderId as a query parameter to the redirect URL.
  const sessionId = redirectSessionId(request);
  if (sessionId) return processSessionAndRedirect(sessionId);

  const tokensParam = getSearchParam(request, "tokens");
  if (tokensParam) return renderSuccessFromTokens(tokensParam);

  const url = new URL(request.url);
  const paramKeys = [...url.searchParams.keys()].join(",") || "none";
  const referer = request.headers.get("referer") ?? "none";
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Payment success callback with no session_id or tokens | params=[${paramKeys}] referer=${referer}`,
  });
  return Promise.resolve(paymentErrorResponse("Invalid payment callback"));
};

/**
 * Handle GET /payment/cancel (redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
/** Log a payment session error with cancel context prefix */
const logCancelError = paymentSessionErrorLogger("cancel");

const handlePaymentCancel = withSessionId(async (sid) => {
  // A buyer who cancels may do so after the operator switched new sales off, so
  // resolve the provider that captured the payment rather than the new-sales gate.
  const attempt = await getExistingPaymentAttempt();
  if (!attempt) {
    logCancelError(`No provider configured (session=${sid})`);
    return paymentErrorResponse("Payment provider not configured");
  }

  const session = await attempt.retrieveSession(sid);
  // A buyer who cancelled can still land here on a charge the boundary could
  // not read, so this answers the same way the success redirect does.
  if (isSessionRejection(session)) {
    return answerRejectedSession(attempt, session, sid, logCancelError);
  }
  if (!session) {
    logCancelError(`Session not found (session=${sid})`);
    return paymentErrorResponse(t("payment.error.session_not_found"));
  }

  return cancelPageResponse(session, logCancelError);
});

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/cancel": handlePaymentCancel,
  "GET /payment/success": handlePaymentSuccess,
  "POST /payment/webhook": handlePaymentWebhook,
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
