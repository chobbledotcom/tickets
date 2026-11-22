import type { BundleRead } from "#db/checkout-bundles.ts";
import type { StoredPaymentFailure } from "#payment/row-state.ts";
import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import { settlesSession } from "#routes/api/payment-processing/index.ts";
import { callbackAnswerFor } from "#routes/api/payment-processing/missing-order.ts";
import { standingOf } from "#routes/api/payment-processing/session-standing.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import {
  corruptedDataFor,
  type ModelDataSource,
  modelDataFor,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";

/** What the sealed row holds for one session. `order` is the whole order,
 * `receipt` is the copy with no personal details that a settled session
 * keeps, and `gone` is a pruned row. The `Record` keys on the production
 * read statuses, so a new status is a type error here: `opened` covers both
 * an order and a receipt, and a row that will not open reads like a pruned
 * one, because both go down the same missing-order branch. */
const BUNDLE_FOR_READ: Record<BundleRead["status"], readonly BundleState[]> = {
  missing: ["gone"],
  opened: ["order", "receipt"],
  unreadable: ["gone"],
};

const BUNDLE_STATES = ["order", "receipt", "gone"] as const;
type BundleState = (typeof BUNDLE_STATES)[number];

/** The processed_payments row. `finalized` holds a booking, `failed` holds a
 * final handled outcome such as a refunded placeholder. */
const ROW_STATES = ["none", "reserved", "finalized", "failed"] as const;
type RowState = (typeof ROW_STATES)[number];

/** Whether the ledger holds any leg in the session's event groups. Both a
 * booking and a refunded placeholder write legs. */
const LEDGER_STATES = ["unrecorded", "recorded"] as const;
type LedgerState = (typeof LEDGER_STATES)[number];

/** The answers one delivery of this model can give, named by the callback
 * outcome that each becomes. */
const ANSWERS = [
  "booked",
  "held",
  "settled",
  "unreadable",
] as const satisfies readonly CallbackOutcome["kind"][];
type Answer = (typeof ANSWERS)[number];

/* jscpd:ignore-start -- static data, not code */
const deliveryFields = {
  alarms: "Bool",
  answer: "Str",
  books: "Bool",
  bundle: "Str",
  ledgerAfter: "Str",
  ledgerBefore: "Str",
  refunds: "Bool",
  rowAfter: "Str",
  rowBefore: "Str",
} as const;
/* jscpd:ignore-end */

type Delivery = {
  readonly alarms: boolean;
  readonly answer: Answer;
  readonly books: boolean;
  readonly bundle: BundleState;
  readonly ledgerAfter: LedgerState;
  readonly ledgerBefore: LedgerState;
  readonly refunds: boolean;
  readonly rowAfter: RowState;
  readonly rowBefore: RowState;
};

/** The production decisions that the producer executes: `standingOf` in
 * session-standing.ts and `callbackAnswerFor` in missing-order.ts answer a
 * session with no readable order, and `settlesSession` in index.ts says
 * which results write the receipt. A test replaces one to inject a fault. */
export type OrderDecisions = {
  readonly answerFor: typeof callbackAnswerFor;
  readonly settles: typeof settlesSession;
  readonly standing: typeof standingOf;
};

const PRODUCTION_DECISIONS: OrderDecisions = {
  answerFor: callbackAnswerFor,
  settles: settlesSession,
  standing: standingOf,
};

/** The final handled outcome that a failed row holds. */
const HANDLED_OUTCOME: StoredPaymentFailure = {
  error: "The payment was refunded.",
  refunded: true,
};

/** The answer of a callback outcome. An outcome outside the model stops the
 * producer, so a new production answer cannot pass as one of these. */
const answerOf = (kind: CallbackOutcome["kind"]): Answer => {
  const answer = ANSWERS.find((known) => known === kind);
  if (answer === undefined) {
    throw new Error(`The sealed order model holds no answer "${kind}".`);
  }
  return answer;
};

/** A delivery that finds no readable order, observed from the production
 * decisions. The standing comes from what the row and the ledger hold: a
 * finalized row names a booking, and a failed row holds a final outcome. The
 * answer table then says whether the admin is told, and what the callback
 * answers. No branch of that path calls a provider, so it refunds nothing. */
const missingOrderDelivery = (
  row: RowState,
  ledger: LedgerState,
  { answerFor, standing }: Pick<OrderDecisions, "answerFor" | "standing">,
): Delivery => {
  const answer = answerFor(
    standing({
      attendeeId: row === "finalized" ? 1 : null,
      failure: row === "failed" ? HANDLED_OUTCOME : null,
      recorded: ledger === "recorded",
    }).kind,
  );
  return {
    alarms: answer.reportsLostOrder,
    answer: answerOf(answer.outcome.kind),
    books: false,
    bundle: "gone",
    ledgerAfter: ledger,
    ledgerBefore: ledger,
    refunds: false,
    rowAfter: row,
    rowBefore: row,
  };
};

/** The deliveries that read an order or a receipt, from
 * `handleReservationConflict` and `replaySessionFromLedger` in index.ts:
 * - a reserved row answers held;
 * - a finalized or failed row replays its result;
 * - no row with a recorded ledger replays from the ledger and heals the row,
 *   to finalized for a live owner or to failed for an orphaned one;
 * - no row with no ledger leg books fresh. That path is the reserve and
 *   settle actions of the model, except from a receipt, where this fact keeps
 *   what production would do: book from a copy with no buyer details. */
const readOrderDeliveries = (
  bundle: BundleState,
  row: RowState,
  ledger: LedgerState,
): Delivery[] => {
  const base = {
    alarms: false,
    bundle,
    ledgerBefore: ledger,
    refunds: false,
    rowBefore: row,
  } as const;
  if (row !== "none") {
    const answer = row === "reserved" ? "held" : "booked";
    return [
      { ...base, answer, books: false, ledgerAfter: ledger, rowAfter: row },
    ];
  }
  if (ledger === "recorded") {
    return (["finalized", "failed"] as const).map((rowAfter) => ({
      ...base,
      answer: rowAfter === "finalized" ? "booked" : "settled",
      books: false,
      ledgerAfter: ledger,
      rowAfter,
    }));
  }
  if (bundle === "receipt") {
    return [
      {
        ...base,
        answer: "booked",
        books: true,
        ledgerAfter: "recorded",
        rowAfter: "finalized",
      },
    ];
  }
  return [];
};

const readableBundles = BUNDLE_FOR_READ.opened;

/** Every delivery outcome for one session: one or two per state triple. */
const deliveriesWith = (decisions: OrderDecisions): Delivery[] =>
  ROW_STATES.flatMap((row) =>
    LEDGER_STATES.flatMap((ledger) => [
      ...readableBundles.flatMap((bundle) =>
        readOrderDeliveries(bundle, row, ledger),
      ),
      missingOrderDelivery(row, ledger, decisions),
    ]),
  );

const DELIVERIES: readonly Delivery[] = deliveriesWith(PRODUCTION_DECISIONS);

/** The result that `processPaymentSession` holds when it leaves each row
 * state, and so decides whether to write the receipt. */
const RESULT_FOR_ROW: Record<RowState, PaymentResult> = {
  // A final handled outcome, such as a refunded placeholder.
  failed: {
    error: "The payment was refunded.",
    refunded: true,
    success: false,
  },
  // A booking.
  finalized: {
    attendee: { id: 1 },
    listingId: 1,
    success: true,
    ticketTokens: [],
  },
  // A refund that did not go through. The row is released for the retry.
  none: { error: "The refund failed.", refunded: false, success: false },
  // Another delivery holds the reservation.
  reserved: {
    error: "Another delivery is at work.",
    status: 409,
    success: false,
  },
};

/** The row states after which the order gives way to a receipt, observed
 * from the production rule. */
const receiptRowsWith = (settles: OrderDecisions["settles"]): RowState[] =>
  ROW_STATES.filter((row) => settles(RESULT_FOR_ROW[row]));

const RECEIPT_ROWS: readonly RowState[] = receiptRowsWith(
  PRODUCTION_DECISIONS.settles,
);

const receiptFields = { rowBefore: "Str" } as const;

const moduleFor = (
  deliveries: readonly Delivery[],
  receiptRows: readonly RowState[],
): string =>
  tlaModule("SealedOrderData", [
    `BundleStates == ${tlaSet(BUNDLE_STATES)}`,
    `RowStates == ${tlaSet(ROW_STATES)}`,
    `LedgerStates == ${tlaSet(LEDGER_STATES)}`,
    tlaRecords("DeliveryFacts", deliveryFields, deliveries),
    tlaRecords(
      "ReceiptFacts",
      receiptFields,
      receiptRows.map((rowBefore) => ({ rowBefore })),
    ),
  ]);

const corruptedDeliveries = corruptedDataFor(DELIVERIES, (deliveries) =>
  moduleFor(deliveries, RECEIPT_ROWS),
);

/** The facts that the producer builds when a production decision has a
 * fault. A test uses it to show that the fault reaches the facts. */
export const sealedOrderDataWithFault = (
  fault: Partial<OrderDecisions>,
): ModelDataSource => {
  const decisions = { ...PRODUCTION_DECISIONS, ...fault };
  return modelDataFor(() =>
    moduleFor(deliveriesWith(decisions), receiptRowsWith(decisions.settles)),
  );
};

/** The clean proof data. The check must pass. */
export const sealedOrderModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES, RECEIPT_ROWS),
);

/** The negative control for a receipt written while the session is still
 *  open: the receipt step also runs on a reserved row or no row. The checker
 *  must reject it. */
export const earlyReceiptData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES, ROW_STATES),
);

/** The negative control for an alarm that skips the settled check: every
 *  delivery with no readable order raises the alarm. */
export const settledAlarmData: ModelDataSource = corruptedDeliveries(
  (delivery) =>
    delivery.bundle === "gone"
      ? { ...delivery, alarms: true, answer: "unreadable" }
      : delivery,
);

/** The negative control for a refund on a lost order. */
export const lostOrderRefundData: ModelDataSource = corruptedDeliveries(
  (delivery) => (delivery.alarms ? { ...delivery, refunds: true } : delivery),
);
