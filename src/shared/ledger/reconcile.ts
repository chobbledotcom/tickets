/**
 * Pure, non-tautological reconciliation checks.
 *
 * `Σ balance == 0` is structurally always true for a one-row-balanced ledger, so
 * it proves nothing. Real integrity comes from comparing the ledger to things
 * outside it: a provider's reported balance, and the leg counts the source
 * records say each event should have.
 */

import { balanceOf } from "./project.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Result of comparing a ledger account to an external source of truth. */
export type ReconcileResult = {
  readonly ok: boolean;
  readonly expected: number;
  readonly actual: number;
  readonly diff: number;
};

/**
 * Reconcile one account's ledger balance against an externally reported figure
 * (e.g. a PSP's reported balance). A non-zero `diff` is real drift — a missed or
 * duplicated event, an unrecorded fee or payout.
 */
export const reconcileExternal =
  (acct: AccountRef, reported: number) =>
  (transfers: Transfer[]): ReconcileResult => {
    const actual = balanceOf(acct)(transfers);
    const diff = actual - reported;
    return { actual, diff, expected: reported, ok: diff === 0 };
  };

/** A per-event mismatch between the leg kinds an event should have and those
 *  actually present in the ledger. */
export type LegKindDiscrepancy = {
  readonly eventGroup: string;
  /** Expected kinds (with multiplicity) absent from the ledger. */
  readonly missing: string[];
  /** Observed kinds (with multiplicity) the source records did not expect. */
  readonly unexpected: string[];
};

/** Elements of `a` not covered by `b`, respecting multiplicity. */
const multisetDiff = (a: string[], b: string[]): string[] => {
  const remaining = new Map<string, number>();
  for (const x of b) remaining.set(x, (remaining.get(x) ?? 0) + 1);
  const extra: string[] = [];
  for (const x of a) {
    const count = remaining.get(x) ?? 0;
    if (count > 0) remaining.set(x, count - 1);
    else extra.push(x);
  }
  return extra;
};

/**
 * Compare the leg *kinds* present per event against what the SOURCE records say
 * each event should have. Driven by `expected` (built from bookings/refunds),
 * comparing kinds rather than a bare count — so a booking that lost its `fee`
 * leg, or one that recorded a second `sale` instead of a `payment`, is caught
 * even though the leg count is unchanged. An event group with no legs reports
 * everything `missing`; one absent from `expected` reports everything
 * `unexpected` (an orphan event).
 */
export const reconcileLegKinds =
  (expected: Map<string, string[]>) =>
  (transfers: Transfer[]): LegKindDiscrepancy[] => {
    const observed = new Map<string, string[]>();
    for (const t of transfers) {
      const kinds = observed.get(t.eventGroup) ?? [];
      kinds.push(t.kind ?? "");
      observed.set(t.eventGroup, kinds);
    }
    const groups = new Set([...expected.keys(), ...observed.keys()]);
    const discrepancies: LegKindDiscrepancy[] = [];
    for (const eventGroup of groups) {
      const want = expected.get(eventGroup) ?? [];
      const got = observed.get(eventGroup) ?? [];
      const missing = multisetDiff(want, got);
      const unexpected = multisetDiff(got, want);
      if (missing.length > 0 || unexpected.length > 0) {
        discrepancies.push({ eventGroup, missing, unexpected });
      }
    }
    return discrepancies;
  };
