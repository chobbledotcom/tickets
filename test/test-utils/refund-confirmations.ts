import { executeBatch } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { insertInto } from "#db/write.ts";
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
  const confirmation = insertInto(tables.refund_confirmations, {
    attendeeId: attendeeId,
    created: nowIso(),
    identity,
  });
  const reference = insertInto(tables.refund_confirmation_references, {
    confirmationIdentity: identity,
    referenceIndex: referenceIndex,
  });
  await executeBatch([confirmation, reference]);
  return { identity, referenceIndex };
};
