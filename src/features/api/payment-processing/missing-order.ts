/**
 * The answers to a paid session whose sealed order cannot be read, as one
 * table. Each row is a place the session stands. Each column is a surface
 * that answers it. A new standing or a new surface is then a compile error
 * until every cell says what happens.
 *
 * The cancel page is not a column: it answers an unpaid checkout, which is
 * open whatever the table says. The rejected-charge paths are not a column
 * either: a malformed charge names no amount to report, and the
 * malformed-charge refund decides its money.
 */

import { t } from "#i18n";
import { sessionAnswerOf } from "#payment/row-state.ts";
import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import { formatPaymentError } from "#routes/api/payment-processing/index.ts";
import {
  type LostBundleReason,
  reportLostBundle,
} from "#routes/api/payment-processing/lost-bundle.ts";
import type { SessionStanding } from "#routes/api/payment-processing/session-standing.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { publicPageResponse } from "#routes/response.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { successPage } from "#templates/payment.tsx";

type StandingKind = SessionStanding["kind"];

/** A paid session of ours whose order cannot be read, and where it stands. */
export type MissingOrder<Kind extends StandingKind = StandingKind> = {
  readonly reason: LostBundleReason;
  readonly session: ValidatedPaymentSession;
  readonly standing: Extract<SessionStanding, { kind: Kind }>;
};

/** What the return page needs from its caller: the refusal page that carries
 * the staff diagnostics of the request. */
export type ReturnPageTools = {
  readonly refuse: (message: string, status: number) => Promise<Response>;
};

/** The provider callback's answer for one standing: the outcome, and whether
 * the admin must be told of a lost order first. */
export type CallbackAnswer = {
  readonly outcome: CallbackOutcome;
  readonly reportsLostOrder: boolean;
};

type AnswerTable = {
  readonly [Kind in StandingKind]: {
    readonly callback: CallbackAnswer;
    readonly returnPage: (
      missing: MissingOrder<Kind>,
      tools: ReturnPageTools,
    ) => Promise<Response>;
  };
};

/** A settled session's callback: acknowledged, with the standing in the log. */
const settledCallback = (detail: string): CallbackAnswer => ({
  outcome: {
    detail,
    error: "This payment has already been processed.",
    kind: "settled",
    listingId: undefined,
  },
  reportsLostOrder: false,
});

/** Tell the admin of the lost order. The note and the activity line land
 * once for the session, however often a surface asks. */
const raiseLostOrder = ({
  reason,
  session,
}: Pick<MissingOrder, "reason" | "session">): Promise<void> =>
  reportLostBundle(session, reason);

const MISSING_ORDER_ANSWERS: AnswerTable = {
  booked: {
    callback: settledCallback(
      "Session already booked, and its sealed order was pruned",
    ),
    returnPage: () =>
      publicPageResponse(() =>
        successPage({ paid: true, thankYouUrl: "", ticketUrl: null }),
      ),
  },
  handled: {
    callback: settledCallback(
      "Session already ended with a final outcome, and its sealed order was pruned",
    ),
    returnPage: ({ standing }) => {
      const answer = sessionAnswerOf(standing.failure);
      return paymentErrorResponse(
        formatPaymentError({ ...answer, success: false }),
        answer.status,
      );
    },
  },
  open: {
    callback: { outcome: { kind: "unreadable" }, reportsLostOrder: true },
    returnPage: async (missing, tools) => {
      await raiseLostOrder(missing);
      return tools.refuse(t("payment.error.verification_failed"), 503);
    },
  },
  recorded: {
    callback: settledCallback(
      "Session already recorded in the ledger, and its sealed order was pruned",
    ),
    returnPage: () =>
      paymentErrorResponse(t("payment.error.already_handled"), 200),
  },
};

/** The table row for a session's standing. The kind picks the row, so each
 * cell sees the standing it was written for. */
const rowFor = <Kind extends StandingKind>(
  missing: MissingOrder<Kind>,
): AnswerTable[Kind] => MISSING_ORDER_ANSWERS[missing.standing.kind];

/** What the provider callback answers for a standing. */
export const callbackAnswerFor = (kind: StandingKind): CallbackAnswer =>
  MISSING_ORDER_ANSWERS[kind].callback;

/** The provider callback's answer to a session with no readable order. */
export const missingOrderCallback = async (
  missing: MissingOrder,
): Promise<CallbackOutcome> => {
  const answer = callbackAnswerFor(missing.standing.kind);
  if (answer.reportsLostOrder) await raiseLostOrder(missing);
  return answer.outcome;
};

/** The buyer's return page answer to a session with no readable order. */
export const missingOrderReturnPage = <Kind extends StandingKind>(
  missing: MissingOrder<Kind>,
  tools: ReturnPageTools,
): Promise<Response> => rowFor(missing).returnPage(missing, tools);
