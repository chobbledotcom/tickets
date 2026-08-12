/**
 * Ledger wiring for an admin full refund.
 *
 * The ledger mirrors a provider refund by reversing the event groups whose money
 * came back. When every provider charge came back that is the whole account;
 * when only some did — a sibling reference the provider refused, say — it is
 * those groups alone, because a buyer who got part of their money back is worse
 * served by a ledger that records none of it. It only auto-reverses when the
 * attendee's account is **paid in full**. Pre-ledger, still-owing, mixed
 * manual-money, or credit accounts are left for a manual adjustment.
 *
 * Posting never throws: the provider refund has already committed by the time we
 * get here, so a ledger write must not turn a completed refund into a 500. But
 * with the `refunded` column gone, the `refund_cash` leg is the *only* record of
 * the refund, so a missed post can't be swallowed silently or the payment would
 * read as un-refunded and stay re-refundable. Instead it returns `{ posted }`:
 * `false` means the ledger does not reflect the refund (a guard-skip to manual
 * adjustment, or a logged write failure), which the caller surfaces.
 */

/* jscpd:ignore-start */
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
/* jscpd:ignore-end */
import {
  asOrderLegs,
  bookingEventGroup,
  mapBooking,
  mapRefund,
  refundEventGroup,
} from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransferGroups } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { legMatches } from "#shared/ledger/legs.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";

type RefundReferences = readonly Pick<
  RefundPaymentReference,
  "index" | "sessionIds"
>[];

/** Exact reference outcomes from one ledger attempt. */
export type RefundLedgerResult = {
  /** References whose returned cash the ledger now records. */
  recorded: ReadonlySet<string>;
  /** References whose returned cash still has no safe ledger record. */
  unrecorded: ReadonlySet<string>;
  /** Returned references whose booking obligation needs an owner choice. */
  reviewReferenceIndexes: ReadonlySet<string>;
};

type ComputedRefund = {
  groups: TransferInput[][];
  result: RefundLedgerResult;
};

const isRefundLeg = (kind: string | undefined): boolean =>
  kind?.startsWith("refund_") ?? false;

/** A provider cash payment: `payment` sourced from the world (card/bank in),
 *  as opposed to an operator-recorded manual payment. */
const isProviderPaymentLeg = legMatches({ from: WORLD, kind: KIND.payment });

const isOperatorMoneyLeg = (leg: Transfer): boolean =>
  leg.kind === KIND.adjustment || leg.kind?.startsWith("manual_") === true;

/** A placeholder's order group is ONLY provider-payment legs (world → attendee,
 *  kind = payment) — no sale, no booking_fee, no adjustment. This is stricter
 *  than "no sale leg": a surcharge-only order (payment + booking_fee but no
 *  sale) must NOT be classified as a placeholder, because reversing it would
 *  cancel the remaining fee receivable. Only a pure payment-only group qualifies. */
const isPaymentOnlyPlaceholder = (group: Transfer[]): boolean =>
  group.length > 0 && group.every(isProviderPaymentLeg);

/** Whether every original order group is provider cash with no sale or fee. */
export const isPaymentOnlyAccount = (legs: Transfer[]): boolean => {
  const groups = accountRefundGroups(legs);
  return groups.length > 0 && groups.every(isPaymentOnlyPlaceholder);
};

type ReferencePlacement = {
  readonly eventGroups: readonly string[];
  readonly index: string;
  readonly named: boolean;
};

const referencePlacements = (
  references: RefundReferences,
): Promise<ReferencePlacement[]> =>
  Promise.all(
    references.map(async (reference) => ({
      eventGroups: (
        await Promise.all(
          reference.sessionIds.map((sessionId) =>
            Promise.all([
              bookingEventGroup(sessionId),
              balanceEventGroup(sessionId),
            ])
          ),
        )
      ).flat(),
      index: reference.index,
      named: reference.sessionIds.length > 0,
    })),
  );

const hasProviderPayment = (group: Transfer[]): boolean =>
  group.some(isProviderPaymentLeg);

const hasOperatorMoney = (group: Transfer[]): boolean =>
  group.some(isOperatorMoneyLeg);

/** The order groups named by returned references. Whole-account and subset
 * reversals have different safety rules, so the planner carries that fact. */
type ReturnedGroups = {
  readonly groups: Transfer[][];
  readonly kind: "subset" | "whole_account";
  readonly placements: readonly ReferencePlacement[];
  readonly unplaced: ReadonlySet<string>;
};

const returnedRefundGroups = async (
  groups: Transfer[][],
  references: RefundReferences,
): Promise<ReturnedGroups> => {
  const providerGroups = new Set(
    groups.filter(hasProviderPayment).map((group) => group[0]!.eventGroup),
  );
  const placements = (await referencePlacements(references)).map(
    (placement) => ({
      ...placement,
      eventGroups: placement.eventGroups.filter((eventGroup) =>
        providerGroups.has(eventGroup)
      ),
    }),
  );
  const returned = new Set(
    placements.flatMap(({ eventGroups }) => eventGroups),
  );
  const cameBack = (group: Transfer[]): boolean =>
    returned.has(group[0]!.eventGroup);
  const namedUnplaced = placements.filter(
    ({ eventGroups, named }) => named && eventGroups.length === 0,
  );
  const unnamed = groups.filter(
    (group) => hasProviderPayment(group) && !cameBack(group),
  );
  // Every provider charge is accounted for, so the whole account reverses,
  // groups carrying no provider payment of their own included. A legacy
  // reference names no session and so cannot say WHICH group it paid for —
  // this is the one place that does not matter, because the answer is all of
  // them.
  const legacyCount = placements.filter(({ named }) => !named).length;
  if (unnamed.length === legacyCount) {
    return {
      groups,
      kind: "whole_account",
      placements,
      unplaced: new Set(namedUnplaced.map(({ index }) => index)),
    };
  }
  // Only some of the account came back. A legacy reference that returned has
  // no session to place it by, so its money belongs to no group we can name:
  // post what we can and let the row say a person has to finish it.
  return {
    groups: groups.filter(cameBack),
    kind: "subset",
    placements,
    unplaced: new Set([
      ...namedUnplaced.map(({ index }) => index),
      ...placements
        .filter(({ named }) => !named)
        .map(({ index }) => index),
    ]),
  };
};

/**
 * The order groups whose reversal is not already in the ledger. Each reversal
 * is posted under a group derived from the booking's, so a re-submit is
 * recognised group by group. "Any refund leg at all" would close the account
 * after a partial reversal and strand every charge that came back later.
 */
const notYetReversed = async (
  legs: Transfer[],
  groups: Transfer[][],
): Promise<Transfer[][]> => {
  const reversed = new Set(
    legs.filter((leg) => isRefundLeg(leg.kind)).map((leg) => leg.eventGroup),
  );
  const done = await Promise.all(
    groups.map(async (group) =>
      reversed.has(await refundEventGroup(group[0]!.eventGroup))
    ),
  );
  return groups.filter((_, index) => done[index] === false);
};

/** The original account event groups that a returned charge may reverse. */
export const accountRefundGroups = (legs: Transfer[]): Transfer[][] => [
  ...Map.groupBy(
    legs.filter((leg) => !isRefundLeg(leg.kind)),
    (leg) => leg.eventGroup,
  ).values(),
];

const groupIds = (groups: readonly Transfer[][]): ReadonlySet<string> =>
  new Set(groups.map((group) => group[0]!.eventGroup));

const indexesNamedByGroups = (
  placements: readonly ReferencePlacement[],
  groups: readonly Transfer[][],
): ReadonlySet<string> => {
  const ids = groupIds(groups);
  return new Set(
    placements
      .filter(({ eventGroups }) =>
        eventGroups.some((eventGroup) => ids.has(eventGroup))
      )
      .map(({ index }) => index),
  );
};

const indexesWhollyInGroups = (
  placements: readonly ReferencePlacement[],
  groups: readonly Transfer[][],
): ReadonlySet<string> => {
  const ids = groupIds(groups);
  return new Set(
    placements
      .filter(
        ({ eventGroups }) =>
          eventGroups.length > 0 &&
          eventGroups.every((eventGroup) => ids.has(eventGroup)),
      )
      .map(({ index }) => index),
  );
};

const refundLedgerResult = (
  references: RefundReferences,
  recorded: ReadonlySet<string> = new Set(),
  reviewReferenceIndexes: ReadonlySet<string> = new Set(),
): RefundLedgerResult => ({
  recorded,
  reviewReferenceIndexes,
  unrecorded: new Set(
    references
      .map(({ index }) => index)
      .filter((index) => !recorded.has(index)),
  ),
});

const isSettledGroup = (
  account: ReturnType<typeof attendeeAccount>,
  group: Transfer[],
): boolean => balanceOf(account)(group) === 0;

const isSafeSubsetGroup = (
  account: ReturnType<typeof attendeeAccount>,
  group: Transfer[],
): boolean =>
  hasProviderPayment(group) &&
  !hasOperatorMoney(group) &&
  (isPaymentOnlyPlaceholder(group) || isSettledGroup(account, group));

const needsObligationReview = (
  account: ReturnType<typeof attendeeAccount>,
  group: Transfer[],
): boolean =>
  hasProviderPayment(group) &&
  !isPaymentOnlyPlaceholder(group) &&
  !isSettledGroup(account, group);

/**
 * Compute one attendee's refund reversal without posting it: the ledger legs to
 * write (empty when already refunded or not a clean order) and whether the ledger
 * records — or will record — the refund. Read-only, so the bulk path can compute
 * many in parallel and post them in one transaction. Shared by the single
 * {@link recordAttendeeRefund} and the batched {@link recordAttendeeRefundsBatch}.
 */
const computeAttendeeRefund = async (
  attendeeId: number,
  references: RefundReferences,
  memo?: string,
): Promise<ComputedRefund> => {
  const account = attendeeAccount(attendeeId);
  const legs = await transfersByAccount(account);
  const groups = accountRefundGroups(legs);
  const returned = await returnedRefundGroups(groups, references);
  const reviewGroups = returned.kind === "subset"
    ? returned.groups.filter((group) => needsObligationReview(account, group))
    : [];
  const eligible = returned.kind === "whole_account"
    ? returned.groups
    : returned.groups.filter((group) => isSafeSubsetGroup(account, group));
  const reviewReferenceIndexes = indexesNamedByGroups(
    returned.placements,
    reviewGroups,
  );
  const recorded = returned.kind === "whole_account"
    ? new Set(
      references
        .map(({ index }) => index)
        .filter((index) => !returned.unplaced.has(index)),
    )
    : indexesWhollyInGroups(returned.placements, eligible);
  const result = refundLedgerResult(
    references,
    recorded,
    reviewReferenceIndexes,
  );
  const orders = await notYetReversed(legs, eligible);
  // Every requested group already carries its reversal: those legs are the
  // durable record, so replay is a no-op success. Unsafe or unplaceable
  // references remain named separately even when every safe group is done.
  if (eligible.length > 0 && orders.length === 0) {
    return { groups: [], result };
  }
  // Operator money stays a person's call: a manual payment or adjustment is
  // not something a new provider refund can mirror back.
  if (
    returned.kind === "whole_account" && groups.some(hasOperatorMoney)
  ) {
    return { groups: [], result: refundLedgerResult(references) };
  }
  if (orders.length === 0) return { groups: [], result };
  // Only auto-reverse a fully-paid account — UNLESS the account is a pure
  // payment-only placeholder (every order group is ONLY provider-payment legs,
  // no sale/fee/adjustment): a quantity-0 stored-but-refunded booking has a
  // non-zero balance (world funded, nothing consumed), but reversing it is
  // clean (refund_cash returns the payment, balance zeroes). This lets the
  // operator's "refresh payment" reconcile a placeholder when a PENDING refund
  // later settles. A surcharge-only order (payment + fee, no sale) does NOT
  // qualify — reversing it would cancel the fee receivable.
  const isPlaceholder = isPaymentOnlyAccount(legs);
  if (
    returned.kind === "whole_account" &&
    !isPlaceholder &&
    balanceOf(account)(legs) !== 0
  ) {
    return { groups: [], result: refundLedgerResult(references) };
  }
  const occurredAt = nowIso();
  return {
    groups: await Promise.all(
      orders.map((order) =>
        mapRefund({
          memo,
          occurredAt,
          orderLegs: order,
        })
      ),
    ),
    result,
  };
};

/**
 * Run one attendee's ledger posting without ever throwing: `post` reports
 * whether the ledger records the refund, and any error it throws is logged
 * (as "`<label>` failed for attendee N") and reported as `{ posted: false }`
 * instead — the provider refund has already settled by the time we post, so a
 * ledger write must not turn it into a 500.
 */
const postWithoutThrowing = async (
  label: string,
  attendeeId: number,
  post: () => Promise<boolean>,
): Promise<{ posted: boolean }> => {
  try {
    return { posted: await post() };
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `${label} failed for attendee ${attendeeId}: ${error}`,
    });
    return { posted: false };
  }
};

/**
 * Post the ledger legs reversing one attendee's booking and report whether the
 * ledger records the refund. `{ posted: true }` when it posts the reversal — or
 * when the attendee is already refunded, so an idempotent re-submit is a no-op
 * success. `{ posted: false }` when the account is not fully paid, has no
 * ledgered order to reverse (→ manual adjustment), or the write fails. Never
 * throws.
 */
export const recordAttendeeRefund = (
  attendeeId: number,
  references: RefundReferences,
  memo?: string,
): Promise<RefundLedgerResult> =>
  (async () => {
    let computed: ComputedRefund;
    try {
      computed = await computeAttendeeRefund(
        attendeeId,
        references,
        memo,
      );
    } catch (error) {
      logError({
        code: ErrorCode.LEDGER_POST,
        detail:
          `refund ledger preparation failed for attendee ${attendeeId}: ${error}`,
      });
      return refundLedgerResult(references);
    }
    try {
      await postTransferGroups(computed.groups);
      return computed.result;
    } catch (error) {
      logError({
        code: ErrorCode.LEDGER_POST,
        detail:
          `refund ledger post failed for attendee ${attendeeId}: ${error}`,
      });
      return refundLedgerResult(
        references,
        new Set(),
        computed.result.reviewReferenceIndexes,
      );
    }
  })();

const mergeRefundLedgerResults = (
  left: RefundLedgerResult | undefined,
  right: RefundLedgerResult,
): RefundLedgerResult => {
  if (left === undefined) return right;
  const unrecorded = new Set([...left.unrecorded, ...right.unrecorded]);
  return {
    recorded: new Set(
      [...left.recorded, ...right.recorded].filter(
        (index) => !unrecorded.has(index),
      ),
    ),
    reviewReferenceIndexes: new Set([
      ...left.reviewReferenceIndexes,
      ...right.reviewReferenceIndexes,
    ]),
    unrecorded,
  };
};

const resultsByAttendee = (
  results: readonly { id: number; result: RefundLedgerResult }[],
): Map<number, RefundLedgerResult> => {
  const byAttendee = new Map<number, RefundLedgerResult>();
  for (const { id, result } of results) {
    byAttendee.set(id, mergeRefundLedgerResults(byAttendee.get(id), result));
  }
  return byAttendee;
};

/**
 * Record refunds for many attendees, returning each attendee's posted status.
 * The fast path computes every reversal and posts them as ONE atomic batch, so a
 * bulk refund doesn't open an interactive write transaction per attendee and
 * contend the single SQLite writer (SQLITE_BUSY) once enough overlap.
 *
 * The batch is all-or-nothing after the provider refunds have committed. On any
 * mapping or write failure, the fallback records each attendee independently:
 * clean reversals land now, while failed ones stay `posted:false` for the
 * retained row state and a later per-group replay to repair. Never throws.
 */
export const recordAttendeeRefundsBatch = async (
  attendees: readonly {
    attendeeId: number;
    references: RefundReferences;
  }[],
): Promise<Map<number, RefundLedgerResult>> => {
  try {
    // Fast path: compute every reversal, then post them all in one batch. A
    // compute read here can throw; the whole thing is guarded so it degrades to
    // the resilient per-attendee fallback rather than 500ing the bulk request.
    const computed = await Promise.all(
      attendees.map(async (attendee) => ({
        id: attendee.attendeeId,
        computed: await computeAttendeeRefund(
          attendee.attendeeId,
          attendee.references,
        ),
      })),
    );
    const groups = computed.flatMap((entry) => entry.computed.groups);
    await postTransferGroups(groups);
    return resultsByAttendee(
      computed.map(({ id, computed }) => ({ id, result: computed.result })),
    );
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail:
        `bulk refund batch failed, falling back to per-attendee (${attendees.length}): ${error}`,
    });
    // Record each attendee independently so one failure never strands the rest:
    // recordAttendeeRefund opens its own transaction, is idempotent (an
    // already-posted refund replays as a no-op), and never throws.
    const results: { id: number; result: RefundLedgerResult }[] = [];
    for (const attendee of attendees) {
      results.push({
        id: attendee.attendeeId,
        result: await recordAttendeeRefund(
          attendee.attendeeId,
          attendee.references,
        ),
      });
    }
    return resultsByAttendee(results);
  }
};

/**
 * The money facts of a stored-but-refunded placeholder: the attendee we kept at
 * quantity 0, the listing the cash was for, and the amount the provider charged.
 * `eventId` keys the booking event group (use the payment session id) so a
 * redelivery replays as a no-op; `occurredAt` is the provider's checkout time.
 */
export type PlaceholderRefundFacts = {
  readonly attendeeId: number;
  readonly listingId: number;
  readonly amount: number;
  readonly occurredAt: string;
  readonly eventId: string;
};

/**
 * Record the cash round-trip of a stored-but-refunded placeholder booking — the
 * quantity-0 line we keep so a signed payment we can't honour is never lost from
 * the diary. Posts the `payment` we received and, when the provider refund
 * succeeded, the `refund_cash` returning it. Both event groups are posted in one
 * atomic batch, so the payment can never commit without its completed refund.
 * Deliberately posts NO `sale` leg:
 * the booking was never honoured, so no revenue is recognised and the quantity-0
 * line's projected `price_paid` stays 0 (a sale leg would re-break that invariant
 * and read as still-paid). A failed refund posts only the payment, so the ledger
 * shows we still hold the customer's money until a manual refund reverses it —
 * `memo` (a PII-free reason code) is stamped on the refund leg.
 *
 * {@link recordAttendeeRefund} can't be reused here: this placeholder records a
 * cash-only booking that was never honoured, so there is no sale leg or
 * fully-paid account to reverse. Never throws — the provider refund has already
 * settled, so a ledger write must not turn it into a 500. `posted` reports
 * whether every required leg was stored: just the payment when no refund
 * completed, or the payment and refund together when one did. A failed post is
 * logged and reported as `posted: false`.
 */
export const recordPlaceholderRefund = (
  facts: PlaceholderRefundFacts,
  memo: string,
  refunded: boolean,
): Promise<{ posted: boolean }> =>
  postWithoutThrowing(
    "placeholder refund ledger post",
    facts.attendeeId,
    async () => {
      // Gross 0 drops the sale leg, leaving just the payment. The refund mapper
      // only needs the leg's money identity, so it can map the reversal before
      // either group is stored and the batch can commit both or neither.
      const payment = await mapBooking({
        amountPaid: facts.amount,
        attendeeId: facts.attendeeId,
        bookingFee: 0,
        eventId: facts.eventId,
        lines: [{ gross: 0, listingId: facts.listingId }],
        modifiers: [],
        occurredAt: facts.occurredAt,
      });
      const groups = refunded
        ? [
          payment,
          await mapRefund({
            memo,
            occurredAt: facts.occurredAt,
            orderLegs: asOrderLegs(payment, facts.occurredAt),
          }),
        ]
        : [payment];
      await postTransferGroups(groups);
      return true;
    },
  );
