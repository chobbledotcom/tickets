import type { BundleRead } from "#db/checkout-bundles.ts";
import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import type { SessionStanding } from "#routes/api/payment-processing/settled-order.ts";
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

/** The answer one delivery gives, named by the callback outcome it becomes. */
type Answer = Extract<
  CallbackOutcome["kind"],
  "booked" | "held" | "settled" | "unreadable"
>;

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

/** `sessionStanding` in settled-order.ts: a booking row, a final-outcome
 * row, a ledger leg, or none of these. */
const standingOf = (
  row: RowState,
  ledger: LedgerState,
): SessionStanding["kind"] => {
  if (row === "finalized") return "booked";
  if (row === "failed") return "handled";
  return ledger === "recorded" ? "recorded" : "open";
};

/** Which standings `classifySessionIntent` answers as settled. The `Record`
 * keys on the production union, so a new standing is a type error here. */
const SETTLED_STANDING: Record<SessionStanding["kind"], boolean> = {
  booked: true,
  handled: true,
  open: false,
  recorded: true,
};

const settled = (row: RowState, ledger: LedgerState): boolean =>
  SETTLED_STANDING[standingOf(row, ledger)];

/** A delivery that finds no readable order. `classifySessionIntent` answers
 * a settled session as settled. Any other session raises the lost-order
 * alarm through `reportLostBundle`, refuses retryably, and refunds nothing. */
const missingOrderDelivery = (row: RowState, ledger: LedgerState): Delivery => {
  const known = settled(row, ledger);
  return {
    alarms: !known,
    answer: known ? "settled" : "unreadable",
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
const DELIVERIES: readonly Delivery[] = ROW_STATES.flatMap((row) =>
  LEDGER_STATES.flatMap((ledger) => [
    ...readableBundles.flatMap((bundle) =>
      readOrderDeliveries(bundle, row, ledger),
    ),
    missingOrderDelivery(row, ledger),
  ]),
);

/** The row states after which `processPaymentSession` replaces the order
 * with a receipt: a booking or a final handled outcome, on the fresh path
 * and on a replay. A retryable failure releases the row and keeps the whole
 * order. */
const RECEIPT_ROWS: readonly RowState[] = ["finalized", "failed"];

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
