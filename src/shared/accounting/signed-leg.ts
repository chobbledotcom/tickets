import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";

/** The direction-carrying parts of a signed correction leg. A positive delta
 * credits `account` and debits `debit`, and a negative one reverses the pair.
 * The poster adds its own event group, kind, and reference. */
export const signedLegParts =
  (account: AccountRef, debit: AccountRef) =>
  (
    delta: number,
  ): Pick<TransferInput, "amount" | "destination" | "source"> => ({
    amount: Math.abs(delta),
    destination: delta > 0 ? account : debit,
    source: delta > 0 ? debit : account,
  });
