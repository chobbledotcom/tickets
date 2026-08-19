import { executeBatch, insert } from "#db/client.ts";
import { nowIso } from "#shared/now.ts";

export type RefundConfirmationFixture = {
  identity: string;
  referenceIndex: string;
};

/** Store one confirmation row without running the refund workflow. */
export const insertRefundConfirmationFixture = async (
  attendeeId: number,
): Promise<RefundConfirmationFixture> => {
  const identity = `confirmation-${crypto.randomUUID()}`;
  const referenceIndex = `reference-${crypto.randomUUID()}`;
  const confirmation = insert("refund_confirmations", {
    attendee_id: attendeeId,
    created: nowIso(),
    identity,
  });
  const reference = insert("refund_confirmation_references", {
    confirmation_identity: identity,
    reference_index: referenceIndex,
  });
  await executeBatch([confirmation, reference]);
  return { identity, referenceIndex };
};
