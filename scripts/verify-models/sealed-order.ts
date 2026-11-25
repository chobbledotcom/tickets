import type { BundleRead } from "#db/checkout-bundles.ts";
import type { RowHolding } from "#db/processed-payments.ts";
import type { StoredPaymentFailure } from "#payment/row-state.ts";
import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import { settlesSession } from "#routes/api/payment-processing/index.ts";
import { callbackAnswerFor } from "#routes/api/payment-processing/missing-order.ts";
import {
  receiptServes,
  standingOf,
} from "#routes/api/payment-processing/session-standing.ts";
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
 * session with no readable order, `receiptServes` in session-standing.ts says
 * whether a receipt stands for the order, and `settlesSession` in index.ts
 * says which results write the receipt. A test replaces one to inject a
 * fault. */
export type OrderDecisions = {
  readonly answerFor: typeof callbackAnswerFor;
  readonly receiptServes: typeof receiptServes;
  readonly settles: typeof settlesSession;
  readonly standing: typeof standingOf;
};

const PRODUCTION_DECISIONS: OrderDecisions = {
  answerFor: callbackAnswerFor,
  receiptServes,
  settles: settlesSession,
  standing: standingOf,
};

/** The final handled outcome that a failed row holds. */
const HANDLED_OUTCOME: StoredPaymentFailure = {
  error: "The payment was refunded.",
  refunded: true,
};

/** What each row state holds, as `rowHolding` reads it: a booking, a final
 * outcome, or nothing. A reserved row holds neither yet. */
const HOLDING_FOR_ROW: Record<RowState, RowHolding> = {
  failed: { failure: HANDLED_OUTCOME, kind: "handled" },
  finalized: { attendeeId: 1, kind: "booked" },
  none: { kind: "none" },
  reserved: { kind: "none" },
};

/** What a delivery that finds a row answers: a reserved row is held, a
 * booking replays as booked, and a final outcome replays as settled. */
const ROW_REPLAY: Record<Exclude<RowState, "none">, Answer> = {
  failed: "settled",
  finalized: "booked",
  reserved: "held",
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
 * answers. No branch of that path calls a provider, so it refunds nothing. A
 * receipt of a session that nothing settled takes this path too, so `bundle`
 * says which row the delivery found. */
const missingOrderDelivery = (
  row: RowState,
  ledger: LedgerState,
  { answerFor, standing }: Pick<OrderDecisions, "answerFor" | "standing">,
  bundle: BundleState = "gone",
): Delivery => {
  const answer = answerFor(
    standing({ recorded: ledger === "recorded", row: HOLDING_FOR_ROW[row] })
      .kind,
  );
  return {
    alarms: answer.reportsLostOrder,
    answer: answerOf(answer.outcome.kind),
    books: false,
    bundle,
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
 *   settle actions of the model. A receipt has no buyer, so it stands for the
 *   order only when `receiptServes` says so. In production it does not for a
 *   session that nothing settled, which then reads as a lost order. */
const readOrderDeliveries = (
  bundle: BundleState,
  row: RowState,
  ledger: LedgerState,
  decisions: OrderDecisions,
): Delivery[] => {
  const base = {
    alarms: false,
    bundle,
    ledgerBefore: ledger,
    refunds: false,
    rowBefore: row,
  } as const;
  if (row !== "none") {
    return [
      {
        ...base,
        answer: ROW_REPLAY[row],
        books: false,
        ledgerAfter: ledger,
        rowAfter: row,
      },
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
    const standing = decisions.standing({
      recorded: false,
      row: HOLDING_FOR_ROW[row],
    });
    return decisions.receiptServes(standing)
      ? [
          {
            ...base,
            answer: "booked",
            books: true,
            ledgerAfter: "recorded",
            rowAfter: "finalized",
          },
        ]
      : [missingOrderDelivery(row, ledger, decisions, "receipt")];
  }
  return [];
};

const readableBundles = BUNDLE_FOR_READ.opened;

/** Every delivery outcome for one session: one or two per state triple. */
const deliveriesWith = (decisions: OrderDecisions): Delivery[] =>
  ROW_STATES.flatMap((row) =>
    LEDGER_STATES.flatMap((ledger) => [
      ...readableBundles.flatMap((bundle) =>
        readOrderDeliveries(bundle, row, ledger, decisions),
      ),
      missingOrderDelivery(row, ledger, decisions),
    ]),
  );

const DELIVERIES: readonly Delivery[] = deliveriesWith(PRODUCTION_DECISIONS);

/** The results that `processPaymentSession` can hold when it leaves each row
 * state, and so decide whether to write the receipt. */
const RESULTS_FOR_ROW: Record<RowState, readonly PaymentResult[]> = {
  failed: [
    // A refund that went through, such as a refunded placeholder.
    { error: "The payment was refunded.", refunded: true, success: false },
    // A session that the ledger already holds with no live booking. It
    // names no refund at all.
    {
      error: "This payment has already been processed.",
      status: 200,
      success: false,
    },
  ],
  // A booking.
  finalized: [
    { attendee: { id: 1 }, listingId: 1, success: true, ticketTokens: [] },
  ],
  // A refund that did not go through. The row is released for the retry.
  none: [{ error: "The refund failed.", refunded: false, success: false }],
  // Another delivery holds the reservation.
  reserved: [
    { error: "Another delivery is at work.", status: 409, success: false },
  ],
};

/** Whether the order gives way to a receipt after a row state. Every result
 * that leaves the same row must agree, so a rule that splits them stops the
 * producer. */
const writesReceiptAfter =
  (settles: OrderDecisions["settles"]) =>
  (row: RowState): boolean => {
    const answers = new Set(RESULTS_FOR_ROW[row].map(settles));
    if (answers.size !== 1) {
      throw new Error(
        `The results that leave a ${row} row disagree on the receipt.`,
      );
    }
    return answers.has(true);
  };

/** The row states after which the order gives way to a receipt, observed
 * from the production rule. */
const receiptRowsWith = (settles: OrderDecisions["settles"]): RowState[] =>
  ROW_STATES.filter(writesReceiptAfter(settles));

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
 * fault. Each control below is one such fault, and the checker must reject
 * it. */
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

/** The negative control for a booking made from a receipt: a receipt stands
 *  for the order of a session that nothing settled. */
export const receiptBooksData: ModelDataSource = sealedOrderDataWithFault({
  receiptServes: () => true,
});

/** The negative control for an alarm for a settled session: the standing
 *  reads a refunded session as open. */
export const settledAlarmData: ModelDataSource = sealedOrderDataWithFault({
  standing: (facts) =>
    facts.row.kind === "handled" ? { kind: "open" } : standingOf(facts),
});

/** The negative control for a lost order that the admin never hears of: the
 *  answer table answers an open session as it answers one that the ledger
 *  holds, settled and quiet. */
export const missedAlarmData: ModelDataSource = sealedOrderDataWithFault({
  answerFor: (kind) => callbackAnswerFor(kind === "open" ? "recorded" : kind),
});

/** The negative control for a refund on a lost order. */
export const lostOrderRefundData: ModelDataSource = corruptedDeliveries(
  (delivery) => (delivery.alarms ? { ...delivery, refunds: true } : delivery),
);
