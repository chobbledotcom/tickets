import { lineGroupIds } from "#booking/signed-metadata.ts";
import { getPackageDisplaysByIds } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { clearSessionTokens } from "#db/processed-payments.ts";
import { unique } from "#fp";
import { validatePaidSession } from "#routes/api/payment-processing/classify.ts";
import {
  formatPaymentError,
  processPaymentSession,
} from "#routes/api/payment-processing/index.ts";
import { failureDetail } from "#routes/api/payment-processing/refunds.ts";
import { staffPaymentDiagnostics } from "#routes/api/payment-processing/staff-diagnostics.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
import {
  parseTokens,
  verifyTokensWithRealLine,
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { namesConcealedIn } from "#shared/package-privacy.ts";
import { successPage } from "#templates/payment.tsx";

/** The `session_id` query param of a payment callback, or "" when absent. */
export const paymentSessionId = (request: Request): string =>
  getSearchParam(request, "session_id");

/** The payment session id from a success redirect: Stripe's `session_id`, or
 * Square's `orderId` when `session_id` is absent. "" when neither is present. */
const redirectSessionId = (request: Request): string =>
  paymentSessionId(request) || getSearchParam(request, "orderId");

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

/** Whether any booked package path conceals listing names. */
const pathsConcealListings = async (
  packageGroupIds: Iterable<number>,
): Promise<boolean> => {
  const groupIds = [...packageGroupIds];
  if (groupIds.length === 0) return false;
  const displays = await getPackageDisplaysByIds(groupIds);
  return namesConcealedIn(displays, groupIds);
};

/** The thank-you redirect for one listing, unless its booked package path
 * conceals listing names. */
const singleListingThankYou = async (
  listingId: number,
  packageGroupIds: Iterable<number>,
): Promise<string> => {
  if (await pathsConcealListings(packageGroupIds)) return "";
  const listing = await getListingWithCount(listingId);
  return listing?.thank_you_url.trim() ?? "";
};

const processSessionAndRedirect = async (
  sessionId: string,
  request: Request,
): Promise<Response> => {
  const validation = await validatePaidSession(sessionId, request);
  if (!validation.ok) return validation.response;

  // A parent booking carries an explicit thank-you URL through its signed
  // metadata so folding a child (which makes the order multi-listing) doesn't
  // drop the parent's configured redirect. The token-derive render keys off the
  // booked listing ids, so it can't recover that URL once >1 listing is booked
  // — that path renders the success page directly here (below), where the
  // verified intent still holds it, rather than redirecting to the token path.
  const intent = validation.data.intent;
  const packageGroupIds = lineGroupIds(intent.items);
  const explicitThankYou =
    intent.thankYouUrl && !(await pathsConcealListings(packageGroupIds))
      ? intent.thankYouUrl
      : "";

  // The ticket token is finalized atomically with the booking, so a racing
  // webhook and redirect always resolve the same attendee and token.
  const result = await processPaymentSession(sessionId, validation.data);

  if (!result.success) {
    // Log once at the redirect boundary
    const listingId = validation.data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[redirect] ${failureDetail(result)}`,
      listingId,
    });
    return paymentErrorResponse(
      formatPaymentError(result),
      result.status,
      await staffPaymentDiagnostics(request, {
        provider: validation.data.session.provider,
        sessionId,
        status: validation.data.session.paymentStatus,
      }),
    );
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
  const thankYouUrl =
    explicitThankYou ||
    (intent.items.length === 1
      ? await singleListingThankYou(result.listingId, packageGroupIds)
      : "");
  return htmlResponse(
    successPage({ paid: true, thankYouUrl, ticketUrl: null }),
  );
};

/** Render the success page from a verified tokens query parameter. */
const renderSuccessFromTokens = async (
  tokensParam: string,
): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  // Only tokens with a real (quantity > 0) line are valid: an all-ghost token's
  // /t link would 404, and a ghost line must not inflate the single-listing
  // thank-you check.
  const { verifiedTokens, listingIds, packageGroupIds } =
    await verifyTokensWithRealLine(tokens);

  if (verifiedTokens.length === 0) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const ticketUrl = `/t/${verifiedTokens.join("+")}`;

  // Only use thank_you_url for one listing on paths that show listing names.
  const uniqueListingIds = unique(listingIds);
  const thankYouUrl =
    uniqueListingIds.length === 1
      ? await singleListingThankYou(uniqueListingIds[0]!, packageGroupIds)
      : "";

  return renderPaidSuccessPage(thankYouUrl, ticketUrl);
};

/** Handle GET /payment/success after a successful payment. */
export const handlePaymentSuccess = async (
  request: Request,
): Promise<Response> => {
  // Stripe uses session_id via {CHECKOUT_SESSION_ID} template variable;
  // Square appends orderId as a query parameter to the redirect URL.
  const sessionId = redirectSessionId(request);
  if (sessionId) return processSessionAndRedirect(sessionId, request);

  const tokensParam = getSearchParam(request, "tokens");
  if (tokensParam) return renderSuccessFromTokens(tokensParam);

  const url = new URL(request.url);
  const paramKeys = [...url.searchParams.keys()].join(",") || "none";
  const referer = request.headers.get("referer") ?? "none";
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Payment success callback with no session_id or tokens | params=[${paramKeys}] referer=${referer}`,
  });
  return paymentErrorResponse(
    "Invalid payment callback",
    400,
    await staffPaymentDiagnostics(request, {}),
  );
};
