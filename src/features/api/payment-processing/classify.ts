/**
 * The validate step of the payment machine: confirm with the provider that a
 * session is paid, then prove — via its signed price proof — that the session is
 * ours before anything downstream processes or refunds it.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { isSessionRejection } from "#payment/validated-session.ts";
/* jscpd:ignore-start -- import block */
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import { answerRejectedSession } from "#routes/api/payment-processing/rejected-target.ts";
import { staffPaymentDiagnostics } from "#routes/api/payment-processing/staff-diagnostics.ts";
import type {
  SessionValidation,
  SignedVerdict,
} from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { htmlResponse } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import {
  getPaymentProviderForExistingPayments,
  type ValidatedPaymentSession,
} from "#shared/payments.ts";
import {
  paymentWaitingPage,
  WAITING_PAGE_RELOAD_LIMIT,
  waitingPageStillReloads,
} from "#templates/payment.tsx";
/* jscpd:ignore-end */

/** Makes a logger that records a payment-session error, prefixed with the
 * payment step it happened on (e.g. "redirect", "cancel"). */
export const paymentSessionErrorLogger =
  (step: string): ((detail: string) => void) =>
  (detail: string): void =>
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[${step}] ${detail}`,
    });

/** Log a payment session error with redirect context prefix */
const logRedirectError = paymentSessionErrorLogger("redirect");

/** The failure page for one refused checkout. When the refuser saw a browser
 * request, an owner reading the page also gets the facts this branch knows. */
const failurePage = async (
  request: Request | undefined,
  message: string,
  facts: { provider?: string; sessionId?: string; status?: string } = {},
  status = 400,
): Promise<Response> =>
  paymentErrorResponse(
    message,
    status,
    await staffPaymentDiagnostics(request, facts),
  );

/** A session that could not be read: log why and return the shared refusal. */
const sessionUnavailable = async (
  sessionId: string,
  why: string,
  request?: Request,
): Promise<SessionValidation> => {
  logRedirectError(`Session ${why} (session=${sessionId})`);
  return {
    ok: false,
    response: await failurePage(request, t("payment.error.session_not_found"), {
      sessionId,
    }),
  };
};

/** Raise a checkout we can prove is ours but whose booking will not read. */
const logUnreadableBooking = paymentSessionErrorLogger("booking");

/** The return URL that names this session — where one click re-asks the
 * provider, and where the waiting page's timed reload goes. */
const returnAgainHref = (sessionId: string): string =>
  `/payment/success?session_id=${encodeURIComponent(sessionId)}`;

/** The reload count the return URL carries, held to a whole number between
 * 0 and the limit, so a forged `wait` value changes no other page fact. */
const reloadsSoFarOn = (request: Request | undefined): number => {
  if (request === undefined) return 0;
  const count = Number(getSearchParam(request, "wait"));
  if (!Number.isInteger(count)) return 0;
  return Math.max(0, Math.min(count, WAITING_PAGE_RELOAD_LIMIT));
};

/**
 * Evaluate a session's price proof against its metadata:
 *  - `null`: no proof at all.
 *  - `{ valid: false }`: a proof is present but doesn't verify (tampered
 *    metadata, or a foreign instance that signed with its own key).
 *  - `{ valid: true, total }`: a genuine proof binding `total`.
 *
 * Only the third case proves the session is ours; the first two both classify as
 * `ignore` (see {@link classifySession}).
 */
const evaluatePriceProof = async (
  session: ValidatedPaymentSession,
): Promise<null | { valid: false } | { valid: true; total: number }> => {
  const proof = session.metadata.price_proof;
  if (!proof) return null;
  const parsed = parsePriceProof(proof);
  if (
    parsed === null ||
    !(await verifyPrice(session.metadata, parsed.total, parsed.sig))
  ) {
    return { valid: false };
  }
  return { total: parsed.total, valid: true };
};

/**
 * The one place the trust matrix lives, so every downstream decision reads one
 * verdict.
 *
 * A valid price proof is the *only* signal that a session is ours. It cannot be
 * forged without our key, and our checkout always attaches one, so the
 * `_origin` marker plays no part: it is unsigned and forgeable.
 *
 * `ignore` neither processes nor refunds, because refunding an unverifiable
 * session can refund another instance's payment. A corrupted session of ours is
 * a support case, not an automatic refund.
 */
type SessionClass = SignedVerdict | { verdict: "ignore" };

/** The complete answer after checking both ownership and the signed booking.
 * A session we cannot prove is ours may be acknowledged. A session we can
 * prove is ours but cannot read must remain retryable. */
export type SessionIntentResult =
  | { kind: "ready"; verdict: SignedVerdict; intent: BookingIntent }
  | { kind: "unverifiable" }
  | { kind: "unreadable" };

export const classifySession = async (
  session: ValidatedPaymentSession,
): Promise<SessionClass> => {
  const evaluation = await evaluatePriceProof(session);
  if (evaluation === null || !evaluation.valid) return { verdict: "ignore" };
  // A charge in a currency other than the site's cannot be honored at the
  // signed total — the amount is in the wrong unit — so it is refused like any
  // other mismatch and refunded rather than dropped.
  if (session.currency !== settings.currency.toUpperCase()) {
    return { agreed: evaluation.total, verdict: "mismatch" };
  }
  return session.amountTotal === evaluation.total
    ? { agreed: evaluation.total, verdict: "trusted" }
    : { agreed: evaluation.total, verdict: "mismatch" };
};

/** Classify both ownership and the booking carried by a paid session. */
export const classifySessionIntent = async (
  session: ValidatedPaymentSession,
): Promise<SessionIntentResult> => {
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") return { kind: "unverifiable" };
  const intent = extractIntent(session);
  if (intent === null) {
    logUnreadableBooking("Signed payment's booking could not be read");
    return { kind: "unreadable" };
  }
  return { intent, kind: "ready", verdict };
};

export const validatePaidSession = async (
  sessionId: string,
  request?: Request,
): Promise<SessionValidation> => {
  // An in-flight checkout may complete after the operator switched new sales
  // off, so resolve the provider that captured the payment rather than the
  // new-sales gate.
  const provider = await getPaymentProviderForExistingPayments();
  if (!provider) {
    logRedirectError(`No payment provider configured (session=${sessionId})`);
    return {
      ok: false,
      response: await failurePage(request, "Payment provider not configured", {
        sessionId,
      }),
    };
  }

  const session = await provider.retrieveSession(sessionId);
  if (isSessionRejection(session)) {
    return {
      ok: false,
      response: await answerRejectedSession(session, logRedirectError, request),
    };
  }
  if (!session) {
    return sessionUnavailable(sessionId, "not found", request);
  }

  // Declined or expired checkout: SumUp's hosted page has a single redirect
  // URL for every outcome, so a card decline lands here. Show the friendly
  // cancel/try-again page, not a "contact support" error.
  if (session.paymentStatus === "failed") {
    return {
      ok: false,
      response: await cancelPageResponse(session, logRedirectError),
    };
  }

  if (session.paymentStatus !== "paid") {
    // A hosted checkout redirects on flow completion, and its transaction
    // status can settle later, so this is a normal state: tell the buyer,
    // not the owner's error channel.
    const reloads = reloadsSoFarOn(request);
    logDebug(
      "Payment",
      `Payment not confirmed yet (session=${sessionId}, status=${session.paymentStatus})`,
    );
    return {
      ok: false,
      response: htmlResponse(
        paymentWaitingPage({
          checkAgainHref: returnAgainHref(sessionId),
          diagnostics: await staffPaymentDiagnostics(request, {
            provider: session.provider,
            sessionId,
            status: session.paymentStatus,
          }),
          refreshUrl: waitingPageStillReloads(reloads)
            ? `${returnAgainHref(sessionId)}&wait=${reloads + 1}`
            : null,
        }),
      ),
    };
  }

  // Only a session carrying a valid price proof is provably ours. Without one we
  // cannot prove ownership (foreign instance sharing the provider, replayed or
  // corrupt data), so we neither process nor refund it — refunding an
  // unverifiable session could refund another instance's payment.
  const classified = await classifySessionIntent(session);
  const knownFacts = {
    provider: session.provider,
    sessionId,
    status: session.paymentStatus,
  };
  if (classified.kind === "unverifiable") {
    logRedirectError(`Unrecognized payment session (session=${sessionId})`);
    return {
      ok: false,
      response: await failurePage(
        request,
        "Payment session not recognized",
        knownFacts,
      ),
    };
  }
  if (classified.kind === "unreadable") {
    return {
      ok: false,
      response: await failurePage(
        request,
        t("payment.error.verification_failed"),
        knownFacts,
        503,
      ),
    };
  }
  return {
    data: {
      intent: classified.intent,
      session,
      verdict: classified.verdict,
    },
    ok: true,
  };
};
