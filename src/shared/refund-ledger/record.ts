/** Post exact refund-ledger plans after provider money has returned. */

import {
  postTransferGroupBatches,
  postTransferGroups,
} from "#accounting/store.ts";
import { uniqueBy } from "#fp";
import { requireValue } from "#shared/required-value.ts";
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

/** Account read + the post's own checks, which travel as one read + write. */
export const REFUND_LEDGER_BATCH_DATABASE_CALLS = 3;

const postComputedRefund = async (
  attendeeId: number,
  computed: ComputedRefund,
): Promise<RefundLedgerResult> => {
  try {
    await postTransferGroups(computed.groups);
    return computed.result;
  } catch (error) {
    logRefundLedgerError({ attendeeId, error, kind: "single_post" });
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
    logRefundLedgerError({ attendeeId, error, kind: "single_preparation" });
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
): readonly { attendeeId: number; computed: ComputedRefund }[] =>
  targets.map(({ attendeeId }, index) => ({
    attendeeId,
    computed: requireValue(
      computed[index],
      `Refund ledger omitted attendee ${attendeeId}`,
    ),
  }));

type RefundLedgerBatchStep<Result> =
  | { kind: "completed"; result: Result }
  | { kind: "failed" };

const runRefundLedgerBatchStep = async <Result>(
  attendeeCount: number,
  kind: "batch_post" | "batch_preparation",
  run: () => Promise<Result>,
): Promise<RefundLedgerBatchStep<Result>> => {
  try {
    return { kind: "completed", result: await run() };
  } catch (error) {
    logRefundLedgerError({ attendeeCount, error, kind });
    return { kind: "failed" };
  }
};

/** Record many attendees from one read snapshot and one bounded write. */
export const recordAttendeeRefundsBatch = async (
  attendees: readonly RefundLedgerTarget[],
): Promise<Map<number, RefundLedgerResult>> => {
  const targets = mergedTargets(attendees);
  if (targets.length === 0) return new Map();
  const computed = await runRefundLedgerBatchStep(
    targets.length,
    "batch_preparation",
    () =>
      computeAttendeeRefunds(
        targets.map(({ attendeeId, references }) => ({
          attendeeId,
          references,
        })),
      ),
  );
  if (computed.kind === "failed") return failureResults(targets);
  const plans = pairedPlans(targets, computed.result);

  const posted = await runRefundLedgerBatchStep(
    targets.length,
    "batch_post",
    () => postTransferGroupBatches(plans.map((plan) => plan.computed.groups)),
  );
  if (posted.kind === "failed") {
    return new Map(
      plans.map(({ attendeeId, computed }) => [
        attendeeId,
        computed.postFailureResult,
      ]),
    );
  }
  return new Map(
    plans.map(({ attendeeId, computed }, index) => {
      const result = requireValue(
        posted.result[index],
        `Refund ledger omitted attendee ${attendeeId}`,
      );
      if (result.kind === "conflict") {
        logRefundLedgerError({
          attendeeId,
          error: result.error,
          kind: "single_post",
        });
        return [attendeeId, computed.postFailureResult];
      }
      return [attendeeId, computed.result];
    }),
  );
};
