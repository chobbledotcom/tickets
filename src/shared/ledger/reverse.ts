/** Pure construction of a reversing transfer (admin void/correction). */

import type { Transfer, TransferInput } from "./types.ts";

/**
 * Metadata the caller supplies for a reversal — the ledger reads no clock and
 * generates no ids, so the new occurredAt/reference/eventGroup/actor are inputs.
 */
export type ReversalMeta = {
  readonly occurredAt: string;
  readonly reference: string;
  readonly eventGroup: string;
  readonly postedBy: string;
  readonly kind?: string;
  readonly memo?: string;
};

/**
 * Build the transfer that exactly undoes `t`: same amount and currency, swapped
 * ends, linked back via `reversesId`. Used only for admin void/correction —
 * refunds are modelled separately (they need many rows per original, so they do
 * not use the one-time `reversesId` link).
 */
export const reverseOf = (t: Transfer, meta: ReversalMeta): TransferInput => ({
  amount: t.amount,
  currency: t.currency,
  destination: t.source,
  eventGroup: meta.eventGroup,
  kind: meta.kind ?? "reversal",
  memo: meta.memo ?? "",
  occurredAt: meta.occurredAt,
  postedBy: meta.postedBy,
  reference: meta.reference,
  reversesId: t.id,
  source: t.destination,
});
