/**
 * Pure, non-tautological reconciliation checks.
 *
 * `Σ balance == 0` is structurally always true for a one-row-balanced ledger, so
 * it proves nothing. Real integrity comes from comparing the ledger to things
 * outside it. It compares a provider's reported balance, and the full set of
 * legs the source records say each event must have.
 */

import { instantToEpochMs } from "#shared/validation/timestamp.ts";
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
 * (for example a PSP's reported balance). A non-zero `diff` is real drift — a
 * missed or duplicated event, an unrecorded fee or payout.
 */
export const reconcileExternal =
  (acct: AccountRef, reported: number) =>
  (transfers: Transfer[]): ReconcileResult => {
    const actual = balanceOf(acct)(transfers);
    const diff = actual - reported;
    return { actual, diff, expected: reported, ok: diff === 0 };
  };

/** The minimal leg shape a fingerprint reads — shared by an expected
 * `TransferInput` and an observed {@link Transfer}. */
type LegFacts = {
  readonly kind?: string;
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: number;
  readonly occurredAt: string;
  readonly reversesId?: number | null;
  readonly reversesGroup?: string;
};

/**
 * A stable, comparable fingerprint of one leg. It covers the kind, the
 * direction (source → destination accounts), the amount, the currency, the
 * business time, and the reversal link. It is JSON-encoded so distinct shapes
 * never collide. The fingerprint is built identically from an expected leg and
 * a stored transfer, so the two sides of a reconciliation compare
 * like-for-like. A leg with the wrong account, amount, or `occurredAt` (which
 * moves it into a different reporting period) differs. So does a leg with a
 * missing or wrong `reversesId` void link, even when its kind matches.
 */
export type LegFingerprint = string;

/**
 * The money-defining facts of a leg, in a fixed order: change any one of them and
 * it is a *different* transfer. Both the reconciliation fingerprint
 * ({@link legFingerprint}) and the replay-equality guard ({@link legIdentityDiff},
 * used by the store's conflict check) derive from this single table. The two
 * can never disagree on what "the same leg" means. Adding a field here updates
 * both at once.
 */
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

export const legFingerprint = (leg: LegFacts): LegFingerprint =>
  JSON.stringify(IDENTITY_FIELDS.map(([, value]) => value(leg)));

/**
 * The identity fields in which two legs differ, empty when they are the same
 * money. Shares {@link IDENTITY_FIELDS} with {@link legFingerprint} so a replay's
 * "stored leg differs in …" report and a reconciliation's fingerprint mismatch
 * always agree on the set of fields that matter.
 */
export const legIdentityDiff = (a: LegFacts, b: LegFacts): string[] =>
  IDENTITY_FIELDS.filter(([, value]) => value(a) !== value(b)).map(
    ([field]) => field,
  );

/** A per-event mismatch between the legs an event must have and those actually
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
 * event must have. The check takes `expected` — fingerprints built from
 * bookings/refunds via {@link legFingerprint}. It compares full leg
 * fingerprints rather than bare kinds or a count. A booking that lost its
 * `fee` leg, paid the wrong account, or recorded the wrong amount is caught
 * even when the leg count is unchanged. An event group with no legs reports
 * everything `missing`. An event group absent from `expected` reports
 * everything `unexpected` (an orphan event).
 */
export const reconcileLegs =
  (expected: Map<string, LegFingerprint[]>) =>
  (transfers: Transfer[]): LegDiscrepancy[] => {
    const observed = new Map(
      [...Map.groupBy(transfers, (t) => t.eventGroup)].map(
        ([eventGroup, legs]) => [eventGroup, legs.map(legFingerprint)],
      ),
    );
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
