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

type AnswerTable = {
  readonly [Kind in StandingKind]: {
    readonly callback: (
      missing: MissingOrder<Kind>,
    ) => Promise<CallbackOutcome>;
    readonly returnPage: (
      missing: MissingOrder<Kind>,
      tools: ReturnPageTools,
    ) => Promise<Response>;
  };
};

/** A settled session's callback: acknowledged, with the standing in the log. */
const settledCallback = (detail: string) => (): Promise<CallbackOutcome> =>
  Promise.resolve({
    detail,
    error: "This payment has already been processed.",
    kind: "settled",
    listingId: undefined,
  });

/** Raise the lost-order alarm. The note and the activity line land once for
 * the session, however often a surface asks. */
const raiseLostOrder = (missing: MissingOrder<"open">): Promise<void> =>
  reportLostBundle(missing.session, missing.reason);

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
    callback: async (missing) => {
      await raiseLostOrder(missing);
      return { kind: "unreadable" };
    },
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

/** The provider callback's answer to a session with no readable order. */
export const missingOrderCallback = <Kind extends StandingKind>(
  missing: MissingOrder<Kind>,
): Promise<CallbackOutcome> => rowFor(missing).callback(missing);

/** The buyer's return page answer to a session with no readable order. */
export const missingOrderReturnPage = <Kind extends StandingKind>(
  missing: MissingOrder<Kind>,
  tools: ReturnPageTools,
): Promise<Response> => rowFor(missing).returnPage(missing, tools);
