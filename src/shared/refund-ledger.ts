/**
 * Ledger wiring for an admin full refund.
 *
 * The provider refund is a full refund of every provider charge recorded for the
 * account, so the ledger mirrors it by reversing every non-refund event group
 * only when all provider-cash groups are covered by the refunded references (see
 * {@link mapRefund}). It only auto-reverses when the attendee's account is
 * **paid in full**. Pre-ledger, still-owing, mixed manual-money, or credit
 * accounts are left for a manual adjustment rather than half- or over-reversed.
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

type RefundReferences = readonly Pick<RefundPaymentReference, "sessionIds">[];
type ComputedRefund = {
  posted: boolean;
  groups: TransferInput[][];
};

const isRefundLeg = (kind: string | undefined): boolean =>
  kind?.startsWith("refund_") ?? false;

/** A provider cash payment: `payment` sourced from the world (card/bank in),
 *  as opposed to an operator-recorded manual payment. */
const isProviderPaymentLeg = legMatches({ from: WORLD, kind: KIND.payment });

const isOperatorMoneyLeg = (leg: Transfer): boolean =>
  leg.kind === KIND.adjustment || leg.kind?.startsWith("manual_") === true;

const refundedSessionGroups = async (
  references: RefundReferences,
): Promise<Set<string>> =>
  new Set(
    (
      await Promise.all(
        references.flatMap((reference) =>
          reference.sessionIds.flatMap((sessionId) => [
            bookingEventGroup(sessionId),
            balanceEventGroup(sessionId),
          ]),
        ),
      )
    ).flat(),
  );

const legacyReferenceCount = (references: RefundReferences): number =>
  references.filter((reference) => reference.sessionIds.length === 0).length;

const hasProviderPayment = (group: Transfer[]): boolean =>
  group.some(isProviderPaymentLeg);

const hasOperatorMoney = (group: Transfer[]): boolean =>
  group.some(isOperatorMoneyLeg);

const coveredRefundGroups = async (
  legs: Transfer[],
  references: RefundReferences,
): Promise<Transfer[][]> => {
  const groups = accountRefundGroups(legs);
  if (groups.some(hasOperatorMoney)) return [];
  const coveredGroups = await refundedSessionGroups(references);
  const uncoveredProviderGroups = groups.filter(
    (group) =>
      hasProviderPayment(group) && !coveredGroups.has(group[0]!.eventGroup),
  );
  return uncoveredProviderGroups.length <= legacyReferenceCount(references)
    ? groups
    : [];
};

/**
 * The account event groups to reverse for a full-account refund. Prior refund
 * groups are ignored; the caller separately treats any refund_cash as already
 * refunded, so a normal re-submit never reaches this mapper.
 */
export const accountRefundGroups = (legs: Transfer[]): Transfer[][] => [
  ...Map.groupBy(
    legs.filter((leg) => !isRefundLeg(leg.kind)),
    (leg) => leg.eventGroup,
  ).values(),
];

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
  // Already refunded (e.g. an idempotent re-submit): the `refund_cash` leg is the
  // durable refund record, so report success without re-posting — and without
  // rebuilding legs under a fresh `nowIso()`.
  if (legs.some((leg) => leg.kind === KIND.refundCash)) {
    return { groups: [], posted: true };
  }
  const orders = await coveredRefundGroups(legs, references);
  if (orders.length === 0) return { groups: [], posted: false };
  // Only auto-reverse a fully-paid account. If the attendee still owes (an
  // unpaid reservation) or holds credit, a full provider refund can't map cleanly
  // onto the ledger: reversing the account while a balance remains would strand
  // receivables or over-refund it. Such cases go to a manual adjustment instead.
  if (balanceOf(account)(legs) !== 0) return { groups: [], posted: false };
  const occurredAt = nowIso();
  return {
    groups: await Promise.all(
      orders.map((order) =>
        mapRefund({
          memo,
          occurredAt,
          orderLegs: order,
        }),
      ),
    ),
    posted: true,
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
): Promise<{ posted: boolean }> =>
  postWithoutThrowing("refund ledger post", attendeeId, async () => {
    const { posted, groups } = await computeAttendeeRefund(
      attendeeId,
      references,
      memo,
    );
    if (groups.length > 0) await postTransferGroups(groups);
    return posted;
  });

/**
 * Record refunds for many attendees, returning each attendee's posted status.
 * The fast path computes every reversal and posts them as ONE atomic batch, so a
 * bulk refund doesn't open an interactive write transaction per attendee and
 * contend the single SQLite writer (SQLITE_BUSY) once enough overlap.
 *
 * But that batch is all-or-nothing, and the provider refunds have *already*
 * committed by the time we post: if one group fails (a reference conflict, a
 * transient write error) — or even a single attendee's read/mapping throws while
 * computing — the whole batch rolls back, and a later retry sees those payments
 * as already-refunded (`refundPayment` returns false) and never re-posts them, so
 * they'd be stranded without a `refund_cash` leg forever. So on *any* fast-path
 * failure we fall back to recording each attendee on its own through the
 * never-throw {@link recordAttendeeRefund}: the clean refunds still land and only
 * the genuinely failing attendees stay errored (`posted:false`). Never throws.
 */
export const recordAttendeeRefundsBatch = async (
  attendees: readonly {
    attendeeId: number;
    references: RefundReferences;
  }[],
): Promise<Map<number, boolean>> => {
  try {
    // Fast path: compute every reversal, then post them all in one batch. A
    // compute read here can throw; the whole thing is guarded so it degrades to
    // the resilient per-attendee fallback rather than 500ing the bulk request.
    const computed = await Promise.all(
      attendees.map(async (attendee) => ({
        id: attendee.attendeeId,
        ...(await computeAttendeeRefund(
          attendee.attendeeId,
          attendee.references,
        )),
      })),
    );
    const groups = computed.flatMap((entry) => entry.groups);
    if (groups.length > 0) await postTransferGroups(groups);
    return new Map(computed.map((entry) => [entry.id, entry.posted]));
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `bulk refund batch failed, falling back to per-attendee (${attendees.length}): ${error}`,
    });
    // Record each attendee independently so one failure never strands the rest:
    // recordAttendeeRefund opens its own transaction, is idempotent (an
    // already-posted refund replays as a no-op), and never throws.
    const result = new Map<number, boolean>();
    for (const attendee of attendees) {
      result.set(
        attendee.attendeeId,
        (await recordAttendeeRefund(attendee.attendeeId, attendee.references))
          .posted,
      );
    }
    return result;
  }
};

/** Money facts for a staged booking refunded before it became a sale.
 * `eventId` keys the payment so redelivery replays as a no-op. */
export type StagedRefundFacts = {
  readonly attendeeId: number;
  readonly listingId: number;
  readonly amount: number;
  readonly occurredAt: string;
  readonly eventId: string;
};

/** Build the cash-only order and its reversal for a paid booking that never
 * became a sale. The caller may store both in its own atomic finalization. */
const stagedRefundMoneyLegs = async (
  facts: StagedRefundFacts,
  memo: string,
): Promise<TransferInput[]> => {
  const payment = await mapBooking({
    amountPaid: facts.amount,
    attendeeId: facts.attendeeId,
    bookingFee: 0,
    eventId: facts.eventId,
    lines: [{ gross: 0, listingId: facts.listingId }],
    modifiers: [],
    occurredAt: facts.occurredAt,
  });
  return [
    ...payment,
    ...(await mapRefund({
      memo,
      occurredAt: facts.occurredAt,
      orderLegs: asOrderLegs(payment, facts.occurredAt),
    })),
  ];
};

export const stagedRefundLegs = (
  facts: StagedRefundFacts,
  memo: string,
): Promise<TransferInput[]> => stagedRefundMoneyLegs(facts, memo);
