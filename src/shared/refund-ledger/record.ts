/** Post exact refund-ledger plans after provider money has returned. */

import { uniqueBy } from "#fp";
import {
  postTransferGroupBatches,
  postTransferGroups,
} from "#shared/accounting/store.ts";
import { logRefundLedgerError } from "./log.ts";
import {
  type ComputedRefund,
  computeAttendeeRefund,
  computeAttendeeRefunds,
} from "./plan.ts";
import {
  type RefundLedgerResult,
  type RefundReferences,
  refundLedgerResult,
} from "./result.ts";

/** Account read + event-group read + reference read + write. Refund legs never
 * carry reversal ids, so the generic reversal-id query is skipped. */
export const REFUND_LEDGER_BATCH_DATABASE_CALLS = 4;

const postComputedRefund = async (
  attendeeId: number,
  computed: ComputedRefund,
): Promise<RefundLedgerResult> => {
  try {
    await postTransferGroups(computed.groups);
    return computed.result;
  } catch (error) {
    logRefundLedgerError(
      `refund ledger post failed for attendee ${attendeeId}: ${error}`,
    );
    return computed.postFailureResult;
  }
};

/**
 * Record every safe reversal for one attendee and name the outcome of each
 * returned provider reference. A failure is logged and returned as unrecorded;
 * money already returned by the provider must not become an HTTP 500.
 */
export const recordAttendeeRefund = async (
  attendeeId: number,
  references: RefundReferences,
  memo?: string,
): Promise<RefundLedgerResult> => {
  let computed: ComputedRefund;
  try {
    computed = await computeAttendeeRefund({
      attendeeId,
      references,
      ...(memo === undefined ? {} : { memo }),
    });
  } catch (error) {
    logRefundLedgerError(
      `refund ledger preparation failed for attendee ${attendeeId}: ${error}`,
    );
    return refundLedgerResult(references);
  }
  return await postComputedRefund(attendeeId, computed);
};

type RefundLedgerTarget = {
  readonly attendeeId: number;
  readonly references: RefundReferences;
};

const mergedTargets = (
  attendees: readonly RefundLedgerTarget[],
): RefundLedgerTarget[] =>
  [...Map.groupBy(attendees, ({ attendeeId }) => attendeeId)].map(
    ([attendeeId, targets]) => ({
      attendeeId,
      references: uniqueBy(
        (reference: RefundReferences[number]) => reference.index,
      )(targets.flatMap(({ references }) => [...references])),
    }),
  );

const failureResults = (
  targets: readonly RefundLedgerTarget[],
): Map<number, RefundLedgerResult> =>
  new Map(
    targets.map(({ attendeeId, references }) => [
      attendeeId,
      refundLedgerResult(references),
    ]),
  );

const pairedPlans = (
  targets: readonly RefundLedgerTarget[],
  computed: readonly ComputedRefund[],
): readonly { attendeeId: number; computed: ComputedRefund }[] => {
  if (computed.length !== targets.length) {
    throw new Error(
      `Refund ledger prepared ${computed.length} plans for ${targets.length} attendees`,
    );
  }
  return targets.map(({ attendeeId }, index) => {
    const plan = computed[index];
    if (plan === undefined) {
      throw new Error(`Refund ledger omitted attendee ${attendeeId}`);
    }
    return { attendeeId, computed: plan };
  });
};

/** Record many attendees from one read snapshot and one bounded write. */
export const recordAttendeeRefundsBatch = async (
  attendees: readonly RefundLedgerTarget[],
): Promise<Map<number, RefundLedgerResult>> => {
  const targets = mergedTargets(attendees);
  if (targets.length === 0) return new Map();
  let computed: ComputedRefund[];
  try {
    computed = await computeAttendeeRefunds(
      targets.map(({ attendeeId, references }) => ({
        attendeeId,
        references,
      })),
    );
  } catch (error) {
    logRefundLedgerError(
      `bulk refund ledger preparation failed (${targets.length}): ${error}`,
    );
    return failureResults(targets);
  }
  const plans = pairedPlans(targets, computed);

  let posted: Awaited<ReturnType<typeof postTransferGroupBatches>>;
  try {
    posted = await postTransferGroupBatches(
      plans.map(({ computed }) => computed.groups),
    );
  } catch (error) {
    logRefundLedgerError(
      `bulk refund ledger post failed (${targets.length}): ${error}`,
    );
    return new Map(
      plans.map(({ attendeeId, computed }) => [
        attendeeId,
        computed.postFailureResult,
      ]),
    );
  }
  if (posted.length !== plans.length) {
    throw new Error(
      `Refund ledger posted ${posted.length} plans for ${plans.length} attendees`,
    );
  }

  return new Map(
    plans.map(({ attendeeId, computed }, index) => {
      const result = posted[index];
      if (result === undefined) {
        throw new Error(`Refund ledger omitted attendee ${attendeeId}`);
      }
      if (result.kind === "conflict") {
        logRefundLedgerError(
          `refund ledger post failed for attendee ${attendeeId}: ${result.error}`,
        );
        return [attendeeId, computed.postFailureResult];
      }
      return [attendeeId, computed.result];
    }),
  );
};
