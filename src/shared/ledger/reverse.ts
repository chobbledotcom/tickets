/** Pure construction of a reversing transfer (admin void/correction). */

import { sameAccount } from "./account.ts";
import type { AccountRef, Transfer, TransferInput } from "./types.ts";

/** The fields that decide whether one leg exactly undoes another. */
type DirectedAmount = {
  readonly amount: number;
  readonly currency: string;
  readonly source: AccountRef;
  readonly destination: AccountRef;
};

/**
 * True when `leg` exactly undoes `original`: same amount and currency, with
 * source and destination swapped. A freshly built reversal (see {@link reverseOf})
 * satisfies this by construction; the store also checks a leg carrying a
 * `reversesId` against it before inserting, so a bad link can't void nothing.
 */
export const isInverseOf = (
  leg: DirectedAmount,
  original: DirectedAmount,
): boolean =>
  leg.amount === original.amount &&
  leg.currency === original.currency &&
  sameAccount(leg.source, original.destination) &&
  sameAccount(leg.destination, original.source);

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
