/* jscpd:ignore-start -- imports */
import {
  type ModelDataSource,
  modelDataFor,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import {
  type BookingLedgerDisposition,
  classifyBookingLedger,
} from "#shared/session-ledger.ts";

/* jscpd:ignore-end */

/** One classifier call per ledger disposition. The `Record` annotation makes
 * a new disposition status a type error here, so the fact table cannot
 * silently miss a ledger state the production classifier can produce.
 * `classifyBookingLedger(hasLegs, ownerAttendeeId)` decides each status, so
 * the model's ledger states are genuinely derived from the ledger code. */
const LEDGER_DISPOSITIONS: Record<
  BookingLedgerDisposition["status"],
  BookingLedgerDisposition
> = {
  booked: classifyBookingLedger(true, 1),
  orphaned: classifyBookingLedger(true, null),
  unrecorded: classifyBookingLedger(false, null),
};

const LEDGER_STATES: readonly string[] = Object.values(LEDGER_DISPOSITIONS).map(
  (disposition) => disposition.status,
);

/** The temporary processed_payments row states this proof tracks. `none` is
 * absent or deleted, the stale cleanup only removes a `reserved` (unresolved)
 * row, and a finalized row carries the attendee id. A terminal-failure row
 * stays outside the proof: a booked ledger can never produce one, and its
 * replay answers from the recorded outcome rather than the ledger. */
const ROW_STATES = ["none", "reserved", "finalized"] as const;

type RowState = (typeof ROW_STATES)[number];

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
  readonly ledgerAfter: BookingLedgerDisposition["status"];
  readonly ledgerBefore: BookingLedgerDisposition["status"];
  readonly refunds: boolean;
  readonly rowAfter: RowState;
  readonly rowBefore: RowState;
};

/** The one delivery for a (ledger, row) pair, from the production branches:
 * - reserveSession claims the missing row, the `unrecorded` ledger replay
 *   answer is null, the booking succeeds and finalizes the row (books).
 * - reserveSession also claims the missing row of a booked ledger, and
 *   replaySuccess then heals that fresh reservation (no booking, no refund).
 * - an existing reserved row answers 409 held; an existing finalized row
 *   replays success; neither books nor refunds.
 * - alreadyHandledSession acknowledges an orphaned ledger. A delivery
 *   to a booked or orphaned ledger never reaches a refund branch, which runs
 *   only after the ledger replay preflight answers `unrecorded`. */
const deliveryFor = (
  disposition: BookingLedgerDisposition,
  rowBefore: RowState,
): Delivery => {
  const status = disposition.status;
  const noRow = rowBefore === "none";
  const freshBooking = status === "unrecorded" && noRow;
  const healsRow = status === "booked" && noRow;
  return {
    books: freshBooking,
    ledgerAfter: freshBooking ? "booked" : status,
    ledgerBefore: status,
    refunds: false,
    rowAfter: freshBooking || healsRow ? "finalized" : rowBefore,
    rowBefore,
  };
};

/** The complete delivery truth table for one payment session: one outcome
 * per (ledger, row) pair. */
const DELIVERIES: readonly Delivery[] = Object.values(
  LEDGER_DISPOSITIONS,
).flatMap((disposition) =>
  ROW_STATES.map((rowBefore) => deliveryFor(disposition, rowBefore)),
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

/** A data source over the deliveries with each one changed by `corrupt`. */
const corruptedModelData = (
  corrupt: (delivery: Delivery) => Delivery,
): ModelDataSource => modelDataFor(() => moduleFor(DELIVERIES.map(corrupt)));

/** The clean proof data. The check must pass. */
export const bookingReplayModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(DELIVERIES),
);

/** The negative control for a duplicate booking: every delivery to an
 *  already booked ledger books again. The checker must reject it. */
export const duplicateBookingData: ModelDataSource = corruptedModelData(
  (delivery) =>
    delivery.ledgerBefore === "booked"
      ? { ...delivery, books: true }
      : delivery,
);

/** The negative control for replay protection that disappears after the
 *  temporary row is deleted: a delivery to a booked ledger with no row
 *  refunds. The checker must reject it. */
export const deletedRowRefundData: ModelDataSource = corruptedModelData(
  (delivery) =>
    delivery.ledgerBefore === "booked" && delivery.rowBefore === "none"
      ? { ...delivery, refunds: true }
      : delivery,
);
