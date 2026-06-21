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

/** A per-event leg-count mismatch. */
export type LegCountDiscrepancy = {
  readonly eventGroup: string;
  readonly expected: number;
  readonly actual: number;
};

/**
 * Compare observed leg counts against what the SOURCE records say each event
 * should have. Driven by `expected` (built from bookings/refunds), not by the
 * ledger itself — so a booking that lost its fee leg, or an event group with no
 * legs at all, is detected. An event group seen in the ledger but absent from
 * `expected` is reported with `expected: 0` (an orphan event).
 */
export const reconcileLegCounts =
  (expected: Map<string, number>) =>
  (transfers: Transfer[]): LegCountDiscrepancy[] => {
    const observed = new Map<string, number>();
    for (const t of transfers) {
      observed.set(t.eventGroup, (observed.get(t.eventGroup) ?? 0) + 1);
    }
    const discrepancies: LegCountDiscrepancy[] = [];
    for (const [eventGroup, want] of expected) {
      const got = observed.get(eventGroup) ?? 0;
      if (got !== want) {
        discrepancies.push({ actual: got, eventGroup, expected: want });
      }
    }
    for (const [eventGroup, got] of observed) {
      if (!expected.has(eventGroup)) {
        discrepancies.push({ actual: got, eventGroup, expected: 0 });
      }
    }
    return discrepancies;
  };
