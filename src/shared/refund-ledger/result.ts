import type { RefundPaymentReference } from "#db/payment-references.ts";

export type RefundReferences = readonly Pick<
  RefundPaymentReference,
  "index" | "sessionIds"
>[];

/** Exact reference outcomes from one ledger attempt. */
export type RefundLedgerResult = {
  /** References whose returned cash the ledger now records. */
  readonly recorded: ReadonlySet<string>;
  /** Returned references whose booking obligation needs an owner choice. */
  readonly reviewReferenceIndexes: ReadonlySet<string>;
  /** References whose returned cash still has no safe ledger record. */
  readonly unrecorded: ReadonlySet<string>;
};

/** Reference indexes absent from a named set. */
export const referenceIndexesOutside = (
  references: RefundReferences,
  indexes: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set(
    references.map(({ index }) => index).filter((index) => !indexes.has(index)),
  );

export const refundLedgerResult = (
  references: RefundReferences,
  recorded: ReadonlySet<string> = new Set(),
  reviewReferenceIndexes: ReadonlySet<string> = new Set(),
): RefundLedgerResult => ({
  recorded,
  reviewReferenceIndexes,
  unrecorded: referenceIndexesOutside(references, recorded),
});
