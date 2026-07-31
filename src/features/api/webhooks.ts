import { unique } from "#fp";
import { t } from "#i18n";
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import {
  formatPaymentError,
  fulfilPayment,
} from "#routes/api/payment-processing/index.ts";
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import {
  htmlResponse,
  jsonResponse,
  plainResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  parseTokens,
  verifyTokensWithRealLine,
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { consumePaymentTicketTokens } from "#shared/db/payments/sessions.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import type { PaymentLocator } from "#shared/payment-runtime/locate.ts";
import {
  type PaymentReconcileOutcome,
  reconcilePayment,
} from "#shared/payment-runtime/process.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import {
  getActivePaymentProvider,
  getPaymentProvider,
} from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { successPage } from "#templates/payment.tsx";

const renderPaidSuccessPage = async (
  thankYouUrl: string,
  ticketUrl: string | null,
): Promise<Response> =>
  htmlResponse(
    successPage({
      fromEmail: await getFromEmailIfConfigured(),
      paid: true,
      thankYouUrl,
      ticketUrl,
    }),
  );

const paymentSessionId = (request: Request): string =>
  getSearchParam(request, "session_id");

const localPaymentId = (request: Request): string =>
  getSearchParam(request, "payment_id");

const redirectSessionId = (request: Request): string =>
  paymentSessionId(request) || getSearchParam(request, "orderId");

const singleListingThankYou = async (listingId: number): Promise<string> => {
  if ((await getHiddenPackageMemberIds([listingId])).size > 0) return "";
  const listing = await getListingWithCount(listingId);
  return listing?.thank_you_url.trim() ?? "";
};

const completedResult = (
  outcome: Extract<PaymentReconcileOutcome, { status: "completed" }>,
): PaymentResult => {
  if ("result" in outcome) return outcome.result;
  const attendeeId = outcome.payment.attendeeId;
  if (attendeeId === null) {
    throw new Error(`Completed payment ${outcome.payment.id} has no attendee`);
  }
  return {
    attendee: { id: attendeeId },
    listingId: outcome.payment.bookingIntent.items[0]!.e,
    success: true,
    ticketTokens: outcome.payment.ticketTokens ?? [],
  };
};

const redirectResult = (
  outcome: PaymentReconcileOutcome,
): PaymentResult | null => {
  switch (outcome.status) {
    case "completed":
      return completedResult(outcome);
    case "fulfilled":
      return outcome.result;
    case "pending":
    case "busy":
      return {
        error: t("payment.error.processing"),
        status: 409,
        success: false,
      };
    case "fully_refunded":
      return {
        error: t("payment.error.refunded"),
        status: 200,
        success: false,
      };
    case "conflict":
      return {
        error: t("payment.error.needs_review"),
        status: 409,
        success: false,
      };
    case "retry":
      return {
        error: t("payment.error.verification_unavailable"),
        status: 503,
        success: false,
      };
    case "ignore":
      return null;
  }
};

const redirectLocator = (
  provider: NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  id: string,
): PaymentLocator =>
  provider.type === "sumup"
    ? { id, kind: "local" }
    : {
        kind: "provider",
        resource: PAYMENT_PROVIDER_RESOURCES[provider.type].session(id),
      };

const reconcileLocalPayment = (
  paymentId: string,
): Promise<PaymentReconcileOutcome> =>
  // Local IDs without an aggregate belong to SumUp's reference-based checkout.
  reconcilePayment("sumup", { id: paymentId, kind: "local" }, fulfilPayment);

type RedirectReconciliation =
  | { outcome: PaymentReconcileOutcome; providerType: PaymentProviderType }
  | { response: Response };

const reconcileRedirectPayment = async (
  request: Request,
): Promise<RedirectReconciliation> => {
  const paymentId = localPaymentId(request);
  if (paymentId !== "") {
    const outcome = await reconcileLocalPayment(paymentId);
    return { outcome, providerType: outcome.payment?.provider ?? "sumup" };
  }
  const provider = await getActivePaymentProvider();
  if (provider === null) {
    return {
      response: paymentErrorResponse(
        t("payment.error.provider_not_configured"),
      ),
    };
  }
  return {
    outcome: await reconcilePayment(
      provider.type,
      redirectLocator(provider, redirectSessionId(request)),
      fulfilPayment,
    ),
    providerType: provider.type,
  };
};

const paymentCancelPage = (
  intent: PaymentWork["intent"],
  paymentId: string,
): Promise<Response> =>
  cancelPageResponse(intent, paymentId, (detail) =>
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[cancel] ${detail}`,
    }),
  );

const cancelledSumupResponse = (
  providerType: PaymentProviderType,
  outcome: PaymentReconcileOutcome,
): Promise<Response> | null =>
  providerType === "sumup" &&
  outcome.status === "ignore" &&
  outcome.payment?.state === "failed"
    ? paymentCancelPage(outcome.payment.bookingIntent, outcome.payment.id)
    : null;

const paidSuccessResponse = async (
  intent: PaymentWork["intent"] | null,
  ticketTokens: string[],
  listingId: number,
): Promise<Response> => {
  const explicitThankYou = intent?.thankYouUrl ?? "";
  if (explicitThankYou && ticketTokens.length > 0) {
    return renderPaidSuccessPage(
      explicitThankYou,
      `/t/${ticketTokens.join("+")}`,
    );
  }
  if (ticketTokens.length > 0) {
    return redirectResponse(
      `/payment/success?tokens=${encodeURIComponent(ticketTokens.join("+"))}`,
    );
  }
  const thankYouUrl =
    explicitThankYou ||
    (intent !== null && intent.items.length === 1
      ? await singleListingThankYou(listingId)
      : "");
  return renderPaidSuccessPage(thankYouUrl, null);
};

const paidResultResponse =
  (outcome: PaymentReconcileOutcome) =>
  async (
    result: Extract<PaymentResult, { success: true }>,
  ): Promise<Response> => {
    const currentPayment =
      outcome.payment !== null && "bookingIntent" in outcome.payment
        ? outcome.payment
        : null;
    const response = await paidSuccessResponse(
      currentPayment?.bookingIntent ?? null,
      result.ticketTokens,
      result.listingId,
    );
    if (
      result.ticketTokens.length > 0 &&
      currentPayment !== null &&
      outcome.status === "completed"
    ) {
      await consumePaymentTicketTokens(currentPayment.id);
    }
    return response;
  };

const withRedirectPayment = async (
  request: Request,
  use: (
    outcome: PaymentReconcileOutcome,
    providerType: PaymentProviderType,
  ) => Promise<Response>,
): Promise<Response> => {
  const reconciled = await reconcileRedirectPayment(request);
  return "response" in reconciled
    ? reconciled.response
    : use(reconciled.outcome, reconciled.providerType);
};

const processSessionAndRedirect = (request: Request): Promise<Response> =>
  withRedirectPayment(request, async (outcome, providerType) => {
    const cancelResponse = cancelledSumupResponse(providerType, outcome);
    if (cancelResponse !== null) return cancelResponse;
    const result = redirectResult(outcome);
    if (result === null)
      return paymentErrorResponse(t("payment.error.session_not_recognized"));
    if (!result.success) {
      return paymentErrorResponse(formatPaymentError(result), result.status);
    }
    return paidResultResponse(outcome)(result);
  });

const renderSuccessFromTokens = async (
  tokensParam: string,
): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  const { verifiedTokens, listingIds } = await verifyTokensWithRealLine(tokens);
  if (verifiedTokens.length === 0) {
    return paymentErrorResponse(t("payment.error.invalid_callback"));
  }
  const listingIdsUnique = unique(listingIds);
  const thankYouUrl =
    listingIdsUnique.length === 1
      ? await singleListingThankYou(listingIdsUnique[0]!)
      : "";
  return renderPaidSuccessPage(thankYouUrl, `/t/${verifiedTokens.join("+")}`);
};

const handlePaymentSuccess = (request: Request): Promise<Response> => {
  const sessionId = redirectSessionId(request);
  if (localPaymentId(request) || sessionId) {
    return processSessionAndRedirect(request);
  }
  const tokens = getSearchParam(request, "tokens");
  return tokens
    ? renderSuccessFromTokens(tokens)
    : Promise.resolve(
        paymentErrorResponse(t("payment.error.invalid_callback")),
      );
};

const handlePaymentCancel = async (request: Request): Promise<Response> => {
  const paymentId = localPaymentId(request);
  const sessionId = paymentSessionId(request);
  if (!paymentId && !sessionId) {
    return paymentErrorResponse(t("payment.error.invalid_callback"));
  }
  return withRedirectPayment(request, async (outcome) => {
    if (outcome.payment === null) {
      return paymentErrorResponse(t("payment.error.session_not_found"));
    }
    if (outcome.status === "completed" || outcome.status === "fulfilled") {
      return processSessionAndRedirect(request);
    }
    if (!("bookingIntent" in outcome.payment)) {
      return paymentErrorResponse(t("payment.error.needs_review"), 409);
    }
    return paymentCancelPage(outcome.payment.bookingIntent, outcome.payment.id);
  });
};

const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  jsonResponse({ received: true, ...extra });

const failedFulfilmentResponse = (
  result: Extract<PaymentResult, { success: false }>,
): Response => {
  if (result.moneyStatus === "not_taken") {
    return webhookAckResponse({ processed: false, status: "not_taken" });
  }
  const refund = result.refund;
  if (refund === undefined) {
    return webhookAckResponse({ processed: false, status: "needs_action" });
  }
  switch (refund.status) {
    case "failed":
      return result.status === 409
        ? webhookAckResponse({ status: "needs_action" })
        : jsonResponse({ status: "retry" }, 503);
    case "pending":
      return webhookAckResponse({ processed: false, status: "pending" });
    case "partial":
      return webhookAckResponse({ processed: false, status: "needs_action" });
    case "completed":
      return webhookAckResponse({ processed: false, status: "fully_refunded" });
  }
};

const webhookResponse = (outcome: PaymentReconcileOutcome): Response => {
  switch (outcome.status) {
    case "completed":
      return webhookAckResponse({
        processed: true,
        replayed: outcome.replayed,
      });
    case "fulfilled":
      if (outcome.result.success)
        return webhookAckResponse({ processed: true });
      return failedFulfilmentResponse(outcome.result);
    case "retry":
      return jsonResponse({ status: "retry" }, 503);
    case "busy":
      return plainResponse("Payment is being processed", 409);
    case "pending":
      return webhookAckResponse({ status: "pending" });
    case "conflict":
      return webhookAckResponse({ status: "needs_action" });
    case "fully_refunded":
      return webhookAckResponse({ status: "fully_refunded" });
    case "ignore":
      return webhookAckResponse();
  }
};

const webhookProviderType = (request: Request): PaymentProviderType =>
  PAYMENT_PROVIDER_IDS.find((provider) => {
    const header = PAYMENT_PROVIDERS[provider].webhookSignatureHeader;
    return header !== null && request.headers.has(header);
  }) ?? "sumup";

const handlePaymentWebhook = async (request: Request): Promise<Response> => {
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);
  const providerType = webhookProviderType(request);
  const provider = await getPaymentProvider(providerType);
  const signatureHeader =
    PAYMENT_PROVIDERS[providerType].webhookSignatureHeader;
  const signature =
    signatureHeader === null
      ? ""
      : (request.headers.get(signatureHeader) ?? "");
  if (provider.requiresWebhookSignature && signature === "") {
    return plainResponse("Missing signature", 400);
  }
  const verified = await provider.verifyWebhookSignature(
    payload,
    signature,
    getPaymentWebhookUrl(),
    payloadBytes,
  );
  if (!verified.valid) return plainResponse(verified.error, 400);
  if (verified.notice === null) return webhookAckResponse();
  if (verified.notice.resource.provider !== provider.type) {
    logDebug("Webhook", "Ignoring a notice for another payment provider");
    return webhookAckResponse();
  }
  return webhookResponse(
    await reconcilePayment(
      provider.type,
      { kind: "provider", resource: verified.notice.resource },
      fulfilPayment,
    ),
  );
};

const paymentRoutes = defineRoutes({
  "GET /payment/cancel": handlePaymentCancel,
  "GET /payment/success": handlePaymentSuccess,
  "POST /payment/webhook": handlePaymentWebhook,
});

export const routePayment = createRouter(paymentRoutes);
