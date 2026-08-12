/* jscpd:ignore-start -- imports */
import { requiredMapValue, sortStrings, unique } from "#fp";
import { t } from "#i18n";
import { logActivity } from "#shared/db/activity-log.ts";
import { withTransaction } from "#shared/db/client.ts";
import {
  createNamedSystemNote,
  deleteNamedSystemNotes,
} from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { assertRefundRowsHeld } from "#shared/db/payment-claim.ts";
import { insertRefundConfirmation } from "#shared/db/refund-confirmations.ts";
import type { Attendee } from "#shared/types.ts";
import type { HeldRefundClaim } from "./claim.ts";
import type { ReadyRefundReference } from "./readiness.ts";

/* jscpd:ignore-end */

type ConfirmedReference = ReadyRefundReference["reference"];
export type RefundConfirmation = "current" | "new";

export type ConfirmedRefund = {
  attendee: Pick<Attendee, "id" | "name">;
  claim: HeldRefundClaim;
  listingId: number;
  paymentOnly: boolean;
  references: readonly ConfirmedReference[];
};

const returnedValues = (
  references: readonly ConfirmedReference[],
  readValue: (reference: ConfirmedReference) => string,
): string[] => sortStrings(unique(references.map(readValue)));

const activityTag = (references: readonly string[]): string =>
  `payment references ${JSON.stringify(references)}`;

/** Finish the operator record atomically while the exact payment claim lives. */
export const confirmRefund = async (
  refund: ConfirmedRefund,
): Promise<RefundConfirmation> => {
  const references = returnedValues(
    refund.references,
    ({ reference }) => reference,
  );
  if (references.length === 0) {
    throw new Error("A refund confirmation needs at least one payment");
  }
  const referenceIndexes = returnedValues(
    refund.references,
    ({ index }) => index,
  );
  const target = attendeeNotes(refund.attendee.id);
  const tag = activityTag(references);
  const confirmation = t("note.placeholder_refund_confirmed");
  const sessionIds = requiredMapValue(
    refund.claim.held,
    refund.attendee.id,
    `Refund confirmation lost attendee ${refund.attendee.id}'s claim`,
  );

  return await withTransaction(async (tx) => {
    await assertRefundRowsHeld(tx, {
      heldSince: refund.claim.heldSince,
      sessionIds,
    });
    const written = await insertRefundConfirmation(tx, {
      attendeeId: refund.attendee.id,
      referenceIndexes,
    });
    if (written.kind === "current") return "current";
    await logActivity(
      `Payment marked as refunded for attendee '${refund.attendee.name}'; ${tag}`,
      refund.listingId,
      refund.attendee.id,
      tx,
    );
    await deleteNamedSystemNotes(
      target,
      "refund_warning",
      referenceIndexes,
      tx,
    );
    if (refund.paymentOnly) {
      await createNamedSystemNote(
        target,
        confirmation,
        { key: written.identity, purpose: "refund_confirmation" },
        tx,
      );
    }
    return "new";
  });
};
