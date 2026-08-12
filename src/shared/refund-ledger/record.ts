/** Post exact refund-ledger plans after provider money has returned. */

import { postTransferGroups } from "#shared/accounting/store.ts";
import { logRefundLedgerError } from "./log.ts";
import { type ComputedRefund, computeAttendeeRefund } from "./plan.ts";
import {
  type RefundLedgerResult,
  type RefundReferences,
  refundLedgerResult,
} from "./result.ts";

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

type RefundLedgerTarget = {
  readonly attendeeId: number;
  readonly references: RefundReferences;
};

/**
 * Record many attendees in one atomic ledger batch. If that batch cannot land,
 * retry each attendee independently so one conflict does not strand the rest.
 */
export const recordAttendeeRefundsBatch = async (
  attendees: readonly RefundLedgerTarget[],
): Promise<Map<number, RefundLedgerResult>> => {
  try {
    const computed = await Promise.all(
      attendees.map(async (attendee) => ({
        computed: await computeAttendeeRefund({
          attendeeId: attendee.attendeeId,
          references: attendee.references,
        }),
        id: attendee.attendeeId,
      })),
    );
    await postTransferGroups(
      computed.flatMap((entry) => entry.computed.groups),
    );
    return resultsByAttendee(
      computed.map(({ id, computed }) => ({ id, result: computed.result })),
    );
  } catch (error) {
    logRefundLedgerError(
      `bulk refund batch failed, falling back to per-attendee (${attendees.length}): ${error}`,
    );
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
