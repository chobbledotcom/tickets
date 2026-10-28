/* jscpd:ignore-start -- imports */
import {
  type ModelDataSource,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { classifyBookingLedger } from "#shared/session-ledger.ts";

/* jscpd:ignore-end */

/** The durable booking ledger's three dispositions, named by the production
 * classifier. `classifyBookingLedger(hasLegs, ownerAttendeeId)` decides them,
 * so the model's ledger states are genuinely derived from the ledger code. */
const LEDGER_STATES: readonly string[] = [
  classifyBookingLedger(false, null).status,
  classifyBookingLedger(true, 1).status,
  classifyBookingLedger(true, null).status,
];

/** The temporary processed_payments row. `none` is absent or deleted, the
 * stale cleanup only removes a `reserved` (unresolved) row, and a finalized
 * row carries the attendee id. */
const ROW_STATES = ["none", "reserved", "finalized"] as const;

const deliveryFields = {
  books: "Bool",
  ledgerAfter: "Str",
  ledgerBefore: "Str",
  refunds: "Bool",
  rowAfter: "Str",
  rowBefore: "Str",
} as const;

/** One delivery's full outcome, transcribed from the reservation, outcome
 * and ledger replay branches it names. `ledgerAfter`/`rowAfter` are what the
 * delivery leaves behind; `books`/`refunds` are what it does to money. */
type Delivery = {
  readonly books: boolean;
  readonly ledgerAfter: string;
  readonly ledgerBefore: string;
  readonly refunds: boolean;
  readonly rowAfter: string;
  readonly rowBefore: string;
};

/** The one delivery for a (ledger, row) pair, from the production branches:
 * - reserveSession claims the missing row, the `unrecorded` ledger replay
 *   answer is null, the booking succeeds and finalizes the row (books).
 * - an existing reserved row answers 409 held; an existing finalized row
 *   replays success; neither books nor refunds.
 * - replaySuccess heals the row of a booked ledger whose temporary row is
 *   gone; alreadyHandledSession acknowledges an orphaned ledger. A delivery
 *   to a booked or orphaned ledger never reaches a refund branch, which runs
 *   only after the ledger replay preflight answers `unrecorded`. */
const deliveryFor = (ledgerBefore: string, rowBefore: string): Delivery => {
  const freshBooking = ledgerBefore === "unrecorded" && rowBefore === "none";
  const healsRow = ledgerBefore === "booked" && rowBefore === "none";
  return {
    books: freshBooking,
    ledgerAfter: freshBooking ? "booked" : ledgerBefore,
    ledgerBefore,
    refunds: false,
    rowAfter: freshBooking || healsRow ? "finalized" : rowBefore,
    rowBefore,
  };
};

/** The complete delivery truth table for one payment session: one outcome
 * per (ledger, row) pair. */
const DELIVERIES: readonly Delivery[] = LEDGER_STATES.flatMap((ledgerBefore) =>
  ROW_STATES.map((rowBefore) => deliveryFor(ledgerBefore, rowBefore)),
);

const moduleFor = (deliveries: readonly Delivery[]): string =>
  tlaModule("BookingReplayData", [
    `LedgerStates == ${tlaSet(LEDGER_STATES)}`,
    `RowStates == ${tlaSet(ROW_STATES)}`,
    tlaRecords(
      "DeliveryFacts",
      deliveryFields,
      deliveries.map((delivery) => delivery),
    ),
  ]);

const modelDataFor =
  (deliveries: readonly Delivery[]): ModelDataSource =>
  async () =>
    moduleFor(deliveries);

/** The clean proof data. The check must pass. */
export const bookingReplayModelData: ModelDataSource = modelDataFor(DELIVERIES);

/** The negative control for a duplicate booking: every delivery to an
 *  already booked ledger books again. The checker must reject it. */
export const duplicateBookingData: ModelDataSource = modelDataFor(
  DELIVERIES.map((delivery) =>
    delivery.ledgerBefore === "booked"
      ? { ...delivery, books: true }
      : delivery,
  ),
);

/** The negative control for replay protection that disappears after the
 *  temporary row is deleted: a delivery to a booked ledger with no row
 *  refunds. The checker must reject it. */
export const deletedRowRefundData: ModelDataSource = modelDataFor(
  DELIVERIES.map((delivery) =>
    delivery.ledgerBefore === "booked" && delivery.rowBefore === "none"
      ? { ...delivery, refunds: true }
      : delivery,
  ),
);
