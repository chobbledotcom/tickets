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

import { groupBy } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  bookingEventGroup,
  mapBooking,
  mapRefund,
} from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransferGroups, postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
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

const sameAccount = (
  left: Transfer["source"],
  right: Transfer["source"],
): boolean => left.type === right.type && left.id === right.id;

const isProviderPaymentLeg = (leg: Transfer): boolean =>
  leg.kind === KIND.payment && sameAccount(leg.source, WORLD);

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
  ...groupBy(
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
 * Post the ledger legs reversing one attendee's booking and report whether the
 * ledger records the refund. `{ posted: true }` when it posts the reversal — or
 * when the attendee is already refunded, so an idempotent re-submit is a no-op
 * success. `{ posted: false }` when the account is not fully paid, has no
 * ledgered order to reverse (→ manual adjustment), or the write fails. Never
 * throws.
 */
export const recordAttendeeRefund = async (
  attendeeId: number,
  references: RefundReferences,
  memo?: string,
): Promise<{ posted: boolean }> => {
  try {
    const { posted, groups } = await computeAttendeeRefund(
      attendeeId,
      references,
      memo,
    );
    if (groups.length > 0) await postTransferGroups(groups);
    return { posted };
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `refund ledger post failed for attendee ${attendeeId}: ${error}`,
    });
    return { posted: false };
  }
};

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
 * succeeded, the `refund_cash` returning it. Deliberately posts NO `sale` leg:
 * the booking was never honoured, so no revenue is recognised and the quantity-0
 * line's projected `price_paid` stays 0 (a sale leg would re-break that invariant
 * and read as still-paid). A failed refund posts only the payment, so the ledger
 * shows we still hold the customer's money until a manual refund reverses it —
 * `memo` (a PII-free reason code) is stamped on the refund leg.
 *
 * {@link recordAttendeeRefund} can't be reused here: this placeholder records a
 * cash-only booking that was never honoured, so there is no sale leg or
 * fully-paid account to reverse. Never throws — the provider refund has already
 * settled, so a ledger write must not turn it into a 500; a failed post is
 * logged and reported as `posted: false`.
 */
export const recordPlaceholderRefund = async (
  facts: PlaceholderRefundFacts,
  memo: string,
  refunded: boolean,
): Promise<{ posted: boolean }> => {
  try {
    // A booking whose only money fact is the cash received: gross 0 drops the
    // sale leg, leaving just the `payment` leg (mapBooking omits zero-amount legs).
    await postTransfers(
      await mapBooking({
        amountPaid: facts.amount,
        attendeeId: facts.attendeeId,
        bookingFee: 0,
        eventId: facts.eventId,
        lines: [{ gross: 0, listingId: facts.listingId }],
        modifiers: [],
        occurredAt: facts.occurredAt,
      }),
    );
    if (!refunded) return { posted: false };
    // Reverse the payment we just posted as refund_cash (read back so mapRefund
    // gets the stored legs). This runs once per session — a redelivery replays the
    // terminal outcome before reaching here — so there is never a prior reversal.
    const payments = (
      await transfersByAccount(attendeeAccount(facts.attendeeId))
    ).filter((leg) => leg.kind === KIND.payment);
    await postTransfers(
      await mapRefund({
        memo,
        occurredAt: facts.occurredAt,
        orderLegs: payments,
      }),
    );
    return { posted: true };
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `placeholder refund ledger post failed for attendee ${facts.attendeeId}: ${error}`,
    });
    return { posted: false };
  }
};
