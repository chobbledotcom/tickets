/**
 * Pure, non-tautological reconciliation checks.
 *
 * `Σ balance == 0` is structurally always true for a one-row-balanced ledger, so
 * it proves nothing. Real integrity comes from comparing the ledger to things
 * outside it: a provider's reported balance, and the full set of legs the source
 * records say each event should have.
 */

import { accountKey } from "./account.ts";
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

/** The minimal leg shape a fingerprint reads — shared by an expected
 *  `TransferInput` and an observed {@link Transfer}. */
type LegFacts = {
  readonly kind?: string;
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly reversesId?: number | null;
};

/**
 * A stable, comparable fingerprint of one leg: its kind, direction (source →
 * destination accounts), amount, currency, business time, and reversal link,
 * JSON-encoded so distinct shapes never collide. Built identically from an
 * expected leg and a stored transfer, so the two sides of a reconciliation
 * compare like-for-like — a leg posted to the wrong account, for the wrong
 * amount, with the wrong `occurredAt` (which moves it into a different reporting
 * period), or with a missing/wrong `reversesId` void link differs even when its
 * kind matches.
 */
export type LegFingerprint = string;

export const legFingerprint = (leg: LegFacts): LegFingerprint =>
  JSON.stringify([
    leg.kind ?? "",
    accountKey(leg.source),
    accountKey(leg.destination),
    leg.amount,
    leg.currency,
    leg.occurredAt,
    leg.reversesId ?? null,
  ]);

/** A per-event mismatch between the legs an event should have and those actually
 *  present in the ledger, compared as {@link LegFingerprint}s. */
export type LegDiscrepancy = {
  readonly eventGroup: string;
  /** Expected legs (with multiplicity) absent from the ledger. */
  readonly missing: LegFingerprint[];
  /** Observed legs (with multiplicity) the source records did not expect. */
  readonly unexpected: LegFingerprint[];
};

/** Elements of `a` not covered by `b`, respecting multiplicity. */
const multisetDiff = (
  a: LegFingerprint[],
  b: LegFingerprint[],
): LegFingerprint[] => {
  const remaining = new Map<string, number>();
  for (const x of b) remaining.set(x, (remaining.get(x) ?? 0) + 1);
  const extra: LegFingerprint[] = [];
  for (const x of a) {
    const count = remaining.get(x) ?? 0;
    if (count > 0) remaining.set(x, count - 1);
    else extra.push(x);
  }
  return extra;
};

/**
 * Compare the legs present per event against what the SOURCE records say each
 * event should have. Driven by `expected` — fingerprints built from
 * bookings/refunds via {@link legFingerprint} — comparing full leg fingerprints
 * rather than bare kinds or a count, so a booking that lost its `fee` leg, paid
 * the wrong account, or recorded the wrong amount is caught even when the leg
 * count is unchanged. An event group with no legs reports everything `missing`;
 * one absent from `expected` reports everything `unexpected` (an orphan event).
 */
export const reconcileLegs =
  (expected: Map<string, LegFingerprint[]>) =>
  (transfers: Transfer[]): LegDiscrepancy[] => {
    const observed = new Map<string, LegFingerprint[]>();
    for (const t of transfers) {
      const legs = observed.get(t.eventGroup) ?? [];
      legs.push(legFingerprint(t));
      observed.set(t.eventGroup, legs);
    }
    const groups = new Set([...expected.keys(), ...observed.keys()]);
    const discrepancies: LegDiscrepancy[] = [];
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
