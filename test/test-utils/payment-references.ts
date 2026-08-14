import { assert } from "@std/assert";
import { expect } from "@std/expect";
import {
  getRefundPaymentReferences,
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReferenceOwner,
  type RefundPaymentReferenceSet,
  type RefundPaymentReferenceSource,
  type TaggedRefundPaymentReference,
} from "#shared/db/payment-references.ts";
import {
  completeRefundAuthority,
  createOrLoadRefundAuthority,
} from "#shared/db/provider-refund-authority.ts";
import { readyRefund } from "#shared/payment/refund-authority.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#shared/payment/refund-provider-authorization.ts";
import { refundReplayUntil } from "#shared/payment/refund-replay-window.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import { recordProviderRefunds } from "#shared/provider-refunds.ts";
import { getTestPrivateKey } from "./crypto.ts";

const RETURNED_AT = 1_700_000_000_000;

/** Build completed authority state through the production transition writers. */
export const markProviderRefundsReturned = async (
  references: readonly TaggedRefundPaymentReference[],
  local: "due" | "recorded" = "recorded",
): Promise<void> => {
  for (const reference of references) {
    const capability = REFUND_PROVIDER_CAPABILITIES[reference.provider];
    const identityIndex = await refundRequestIdentityIndex(reference, 1);
    const request =
      capability === "keyless"
        ? { capability, generation: 1, identityIndex }
        : {
            capability,
            generation: 1,
            identityIndex,
            replayUntil: refundReplayUntil(reference.provider, RETURNED_AT),
          };
    const row = await createOrLoadRefundAuthority({
      captured: { amount: 500, currency: "GBP" },
      now: RETURNED_AT,
      reference,
      state: readyRefund({
        evidenceRevision: 1,
        nextActionAt: RETURNED_AT,
        now: RETURNED_AT,
        request,
      }),
    });
    const completed = await completeRefundAuthority(
      row,
      row.captured,
      RETURNED_AT,
      "provider",
    );
    assert(
      completed !== null,
      "Test refund authority completion lost its revision",
    );
    if (local === "recorded") {
      await recordProviderRefunds([completed], RETURNED_AT + 1);
    }
  }
};

export const requireCompleteRefundReferences = (
  set: RefundPaymentReferenceSet,
  context = "Test payment history",
): TaggedRefundPaymentReference[] => {
  const problem = {
    complete: "is complete",
    legacy_unindexed: "is unexpectedly unindexed",
    provider_unknown: "has no recorded payment provider",
    too_many_references: "has unexpectedly many payment references",
  } satisfies Record<RefundPaymentReferenceSet["kind"], string>;
  assert(set.kind === "complete", `${context} ${problem[set.kind]}`);
  return set.references;
};

export const getCompleteRefundPaymentReferences = async (
  attendees: readonly RefundPaymentReferenceSource[],
): Promise<Map<number, TaggedRefundPaymentReference[]>> =>
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
): Promise<TaggedRefundPaymentReference[]> =>
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
