/**
 * Transfer `kind` literals — the single home for every kind the accounting
 * layer posts or filters on, extending the treatment `service_cost` always had
 * ("the single source of truth for the literal, so the reader/writer and the
 * predicates can't drift apart") to the whole family. The core ledger keeps
 * `kind` opaque; the SQL projections, the mappers, the refund logic, and the
 * template's plain-language descriptions all speak these names via this table.
 *
 * The owner-entered `manual_*` kinds live with their spec table in
 * `./manual-entries.ts` — they are a separate, closed family keyed by
 * `ManualLedgerEntryType`.
 */

export const KIND = {
  /** A manual `writeoff` correction leg (decision 14). */
  adjustment: "adjustment",
  /** The operator's booking-fee income leg. */
  fee: "fee",
  /** A discount/surcharge modifier's signed effect. */
  modifier: "modifier",
  /** Cash received now (a deposit or the full amount). */
  payment: "payment",
  /** Cash handed back to the world on a refund. */
  refundCash: "refund_cash",
  /** A refunded booking's reversed `fee` leg. */
  refundFee: "refund_fee",
  /** A refunded booking's reversed `modifier` leg. */
  refundModifier: "refund_modifier",
  /** A refunded booking's reversed `sale` leg. */
  refundSale: "refund_sale",
  /** An admin void — a transfer that exactly undoes another via `reverses_id`. */
  reversal: "reversal",
  /** Gross ticket revenue recognised at sale. */
  sale: "sale",
  /** An operator-recorded service cost (and its correcting adjustment legs). */
  serviceCost: "service_cost",
} as const;

/** One of the accounting layer's own transfer kinds. */
export type TransferKind = (typeof KIND)[keyof typeof KIND];

const TRANSFER_KINDS: ReadonlySet<string> = new Set(Object.values(KIND));

/** Keep opaque stored kinds at the boundary until they match the closed family. */
export const isTransferKind = (value: string): value is TransferKind =>
  TRANSFER_KINDS.has(value);
