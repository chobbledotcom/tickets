import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import {
  getAttendeeActivityMessages,
  logActivity,
} from "#shared/db/activity-log.ts";
import { withTransaction } from "#shared/db/client.ts";
import {
  createSystemNote,
  deleteNotes,
  getNotesFor,
} from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { assertRefundRowsHeld } from "#shared/db/payment-claim.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import type { HeldRefundClaim } from "./claim.ts";
import type { ReadyRefundReference } from "./readiness.ts";

type ConfirmedReference = ReadyRefundReference["reference"];
export type RefundConfirmation = "current" | "new";

export type ConfirmedRefund = {
  attendee: Pick<Attendee, "id" | "name">;
  claim: HeldRefundClaim;
  listingId: number;
  paymentOnly: boolean;
  references: readonly ConfirmedReference[];
};

const returnedReferences = (
  references: readonly ConfirmedReference[],
): string[] =>
  [...new Set(references.map(({ reference }) => reference))].sort();

const activityTag = (references: readonly string[]): string =>
  `payment references ${JSON.stringify(references)}`;

const namesReturnedPayment = (
  note: string,
  references: readonly string[],
): boolean =>
  note.includes("could NOT be refunded") &&
  references.some((reference) => note.includes(reference));

/** Finish the operator record atomically while the exact payment claim lives. */
export const confirmRefund = async (
  refund: ConfirmedRefund,
): Promise<RefundConfirmation> => {
  const references = returnedReferences(refund.references);
  if (references.length === 0) {
    throw new Error("A refund confirmation needs at least one payment");
  }
  const privateKey = await requireRequestPrivateKey();
  const target = attendeeNotes(refund.attendee.id);
  const [activities, notes] = await Promise.all([
    getAttendeeActivityMessages(refund.attendee.id, privateKey),
    getNotesFor(target, privateKey),
  ]);
  const tag = activityTag(references);
  const alreadyLogged = activities.some((message) => message.endsWith(tag));
  const confirmation = t("note.placeholder_refund_confirmed");
  const alreadyConfirmed = notes.some(
    (note) => note.type === "system" && note.note === confirmation,
  );
  const staleNoteIds = notes
    .filter(
      (note) =>
        note.type === "system" && namesReturnedPayment(note.note, references),
    )
    .map((note) => note.id);
  const sessionIds = requiredMapValue(
    refund.claim.held,
    refund.attendee.id,
    `Refund confirmation lost attendee ${refund.attendee.id}'s claim`,
  );

  await withTransaction(async (tx) => {
    await assertRefundRowsHeld(tx, {
      heldSince: refund.claim.heldSince,
      sessionIds,
    });
    if (!alreadyLogged) {
      await logActivity(
        `Payment marked as refunded for attendee '${refund.attendee.name}'; ${tag}`,
        refund.listingId,
        refund.attendee.id,
        tx,
      );
    }
    await deleteNotes(target, staleNoteIds, tx);
    if (refund.paymentOnly && !alreadyConfirmed) {
      await createSystemNote(target, confirmation, tx);
    }
  });
  return alreadyLogged ? "current" : "new";
};
