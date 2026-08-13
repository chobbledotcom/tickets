import { expect } from "@std/expect";
import {
  getRefundPaymentReferences,
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReference,
  type RefundPaymentReferenceOwner,
  type RefundPaymentReferenceSet,
  type RefundPaymentReferenceSource,
} from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "./crypto.ts";

export const requireCompleteRefundReferences = (
  set: RefundPaymentReferenceSet,
  context = "Test payment history",
): RefundPaymentReference[] => {
  if (set.kind === "legacy_unindexed") {
    throw new Error(`${context} is unexpectedly unindexed`);
  }
  return set.references;
};

export const getCompleteRefundPaymentReferences = async (
  attendees: readonly RefundPaymentReferenceSource[],
): Promise<Map<number, RefundPaymentReference[]>> =>
  new Map(
    [
      ...(await getRefundPaymentReferences(
        attendees.map(({ id, payment_id }) => ({
          currentPaymentId: payment_id,
          id,
        })),
        await getTestPrivateKey(),
      )),
    ].map(([attendeeId, set]) => [
      attendeeId,
      requireCompleteRefundReferences(set, `Attendee ${attendeeId}`),
    ]),
  );

export const getCompleteRefundPaymentReferencesForAttendee = async (
  attendee: RefundPaymentReferenceSource | RefundPaymentReferenceOwner,
): Promise<RefundPaymentReference[]> =>
  requireCompleteRefundReferences(
    await getRefundPaymentReferencesForAttendee(
      "currentPaymentId" in attendee
        ? attendee
        : {
            currentPaymentId: attendee.payment_id,
            id: attendee.id,
          },
      await getTestPrivateKey(),
    ),
    `Attendee ${attendee.id}`,
  );

export const expectRefundReferences = async (
  attendeeId: number,
  expectedReferences: string[],
) => {
  const references = await getCompleteRefundPaymentReferences([
    { id: attendeeId, payment_id: "" },
  ]);
  expect(
    references.get(attendeeId)!.map((reference) => reference.reference),
  ).toEqual(expectedReferences);
};
