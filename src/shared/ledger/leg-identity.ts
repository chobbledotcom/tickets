// effects: pure
/**
 * What makes two ledger legs the same money. A replay of an event must carry
 * the legs that the store already holds. This module names the fields in which
 * a replayed leg differs.
 */

import { instantToEpochMs } from "#shared/validation/timestamp.ts";
import { accountKey } from "./account.ts";
import type { AccountRef } from "./types.ts";

/** The leg facts that the comparison reads. A new `TransferInput` and a
 * stored `Transfer` both carry them. */
type LegFacts = {
  readonly kind?: string;
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: number;
  readonly occurredAt: string;
  readonly reversesId?: number | null;
  readonly reversesGroup?: string;
};

/** The facts that define the money of a leg, in a fixed order. A change to
 * one of them makes a different transfer. */
const IDENTITY_FIELDS: ReadonlyArray<
  readonly [field: string, value: (leg: LegFacts) => string | number | null]
> = [
  ["kind", (leg) => leg.kind ?? ""],
  ["source", (leg) => accountKey(leg.source)],
  ["destination", (leg) => accountKey(leg.destination)],
  ["amount", (leg) => leg.amount],
  // Compare the instant, not its string form. The store persists time as
  // epoch-millis and reads it back canonical. A replay can carry the same
  // moment in a different ISO form, for example without milliseconds or with
  // an offset. Such a replay must match the stored leg rather than read as an
  // occurredAt conflict.
  ["occurredAt", (leg) => instantToEpochMs(leg.occurredAt)],
  ["reversesId", (leg) => leg.reversesId ?? null],
  ["reversesGroup", (leg) => leg.reversesGroup ?? ""],
];

/** The identity fields in which two legs differ. The list is empty when
 * they are the same money. */
export const legIdentityDiff = (a: LegFacts, b: LegFacts): string[] =>
  IDENTITY_FIELDS.filter(([, value]) => value(a) !== value(b)).map(
    ([field]) => field,
  );
