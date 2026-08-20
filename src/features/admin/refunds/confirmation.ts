/* jscpd:ignore-start -- imports */

import { logActivity } from "#db/activity-log.ts";
import { withTransaction } from "#db/client.ts";
import { createSystemNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import { assertRefundRowsHeld } from "#db/payment-claim.ts";
import { insertRefundConfirmation } from "#db/refund-confirmations.ts";
import { requiredMapValue, sortStrings, unique } from "#fp";
import { t } from "#i18n";
import type { Attendee } from "#types";
import type { HeldRefundClaim } from "./claim.ts";
import type { ReadyRefundReference } from "./readiness.ts";

/* jscpd:ignore-end */

type ConfirmedReference = ReadyRefundReference["reference"];
export type RefundConfirmation = "current" | "new";

export type ConfirmedRefund = {
  attendee: Pick<Attendee, "id">;
  claim: HeldRefundClaim;
  listingId: number;
  paymentOnly: boolean;
  references: readonly ConfirmedReference[];
};

const returnedValues = (
  references: readonly ConfirmedReference[],
  readValue: (reference: ConfirmedReference) => string,
): string[] => sortStrings(unique(references.map(readValue)));

/** Finish the operator record atomically while the exact payment claim lives. */
export const confirmRefund = async (
  refund: ConfirmedRefund,
): Promise<RefundConfirmation> => {
  if (refund.references.length === 0) {
    throw new Error("A refund confirmation needs at least one payment");
  }
  const referenceIndexes = returnedValues(
    refund.references,
    ({ index }) => index,
  );
  const target = attendeeNotes(refund.attendee.id);
  const confirmation = t("note.placeholder_refund_confirmed");
  const sessionIds = requiredMapValue(
    refund.claim.held,
    refund.attendee.id,
    `Refund confirmation lost attendee ${refund.attendee.id}'s claim`,
  );
  const phases = new Map(
    sessionIds.map((sessionId) => [
      sessionId,
      requiredMapValue(
        refund.claim.phases,
        sessionId,
        "Refund confirmation lost a payment-row phase",
      ),
    ]),
  );

  return await withTransaction(async (tx) => {
    await assertRefundRowsHeld(tx, {
      commandId: refund.claim.commandId,
      heldSince: refund.claim.heldSince,
      phases,
    });
    const written = await insertRefundConfirmation(tx, {
      attendeeId: refund.attendee.id,
      referenceIndexes,
    });
    if (written.kind === "current") return "current";
    await logActivity(
      "Payment marked as refunded",
      refund.listingId,
      refund.attendee.id,
      tx,
    );
    if (refund.paymentOnly) {
      await createSystemNote(
        target,
        confirmation,
        { key: written.identity, purpose: "refund_confirmation" },
        tx,
      );
    }
    return "new";
  });
};
