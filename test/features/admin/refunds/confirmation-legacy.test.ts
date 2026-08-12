import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { confirmRefund } from "#routes/admin/refunds/confirmation.ts";
import { attendeePiiWriteStatements } from "#shared/db/attendees/pii-write.ts";
import { execute, executeBatch, queryOne } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { PRUNE_PAYMENTS_RETENTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import {
  placeholderRefund,
  placeholderRefundNote,
} from "#shared/payment/placeholder-refund.ts";
import type { Attendee } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeePiiOf,
  resaveAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import { releaseClaimRows } from "#test-utils/payment-claim.ts";
import { withTestSession } from "#test-utils/session.ts";
import {
  type ConfirmationFixture,
  DEFAULT_PAYMENT,
  setupConfirmation,
} from "./confirmation-fixture.ts";

const createLegacyWarning = (attendee: Attendee): Promise<void> =>
  createSystemNote(
    attendeeNotes(attendee.id),
    placeholderRefundNote(
      attendee.id,
      placeholderRefund("price_changed")("legacy detail"),
      false,
      DEFAULT_PAYMENT.paymentReference,
    ),
  );

const capturedAttendee = (attendee: Attendee | null): Attendee => {
  if (attendee === null) throw new Error("the attendee was not captured");
  return attendee;
};

const setupLegacyWarningConfirmation = async (): Promise<{
  attendee: Attendee;
  refund: ConfirmationFixture;
}> => {
  let attendee: Attendee | null = null;
  const refund = await setupConfirmation([DEFAULT_PAYMENT], {
    beforeClaim: async (current) => {
      attendee = current;
      await createLegacyWarning(current);
    },
    paymentId: DEFAULT_PAYMENT.paymentReference,
  });
  return { attendee: capturedAttendee(attendee), refund };
};

const expectNoLegacyWarning = async (
  refund: Pick<ConfirmationFixture, "attendee" | "privateKey">,
): Promise<void> => {
  expect(
    (
      await getNotesFor(attendeeNotes(refund.attendee.id), refund.privateKey)
    ).filter((note) => note.note.includes("could NOT be refunded")),
  ).toEqual([]);
};

describeWithEnv("admin refunds > legacy confirmation", { db: true }, () => {
  test("retires the exact warning materialized when the attendee is saved", async () => {
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      beforeClaim: async (attendee) => {
        const target = attendeeNotes(attendee.id);
        await createLegacyWarning(attendee);
        await createSystemNote(
          target,
          `Imported provider note for ${DEFAULT_PAYMENT.paymentReference}; keep this history.`,
        );
        const unnamed = await queryOne<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM system_notes AS note
            WHERE note.entity_type = 'attendee'
              AND note.entity_id = ?
              AND note.system_name IS NULL`,
          [attendee.id],
        );
        expect(unnamed?.count).toBe(2);
        await resaveAttendee(attendee);
      },
      paymentId: DEFAULT_PAYMENT.paymentReference,
    });
    const target = attendeeNotes(refund.attendee.id);
    const beforeConfirmation = await getNotesFor(target, refund.privateKey);
    expect(
      beforeConfirmation.filter((note) =>
        note.note.includes("could NOT be refunded"),
      ),
    ).toHaveLength(1);
    expect(
      beforeConfirmation.filter((note) =>
        note.note.includes("Imported provider note"),
      ),
    ).toHaveLength(1);
    expect(refund.references).toHaveLength(1);
    const storedPayments = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM processed_payments AS payment
        WHERE payment.attendee_id = ?`,
      [refund.attendee.id],
    );
    expect(storedPayments?.count).toBe(1);

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");

    expect(
      (await getNotesFor(target, refund.privateKey)).map((note) => note.note),
    ).toEqual([
      `Imported provider note for ${refund.reference.reference}; keep this history.`,
      t("note.placeholder_refund_confirmed"),
    ]);
  });

  test("later save and replay retire a warning confirmed while unnamed", async () => {
    const { attendee, refund } = await setupLegacyWarningConfirmation();

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");
    await resaveAttendee(attendee);
    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("current");

    await expectNoLegacyWarning(refund);
  });

  test("a save prepared first cannot restore a warning after confirmation", async () => {
    const { attendee, refund } = await setupLegacyWarningConfirmation();
    const staleSave = await attendeePiiWriteStatements(
      attendee.id,
      attendeePiiOf(attendee),
    );
    await markPaymentReferencesProviderRefunded([refund.reference]);

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");
    await executeBatch(staleSave);

    await expectNoLegacyWarning(refund);
  });

  test("a later save remembers confirmation after its payment row is pruned", async () => {
    let attendee: Attendee | null = null;
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      beforeClaim: async (current) => {
        attendee = current;
        await resaveAttendee(current);
        await createLegacyWarning(current);
      },
      paymentId: DEFAULT_PAYMENT.paymentReference,
    });
    await markPaymentReferencesProviderRefunded([refund.reference]);
    await postAttendeeRefund({
      attendeeId: refund.attendee.id,
      listingId: refund.listingId,
    });

    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");
    await releaseClaimRows(refund.claim, [refund.sessionId]);
    await execute(
      `UPDATE processed_payments
          SET processed_at = ?
        WHERE attendee_id = ?`,
      [
        new Date(nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000).toISOString(),
        refund.attendee.id,
      ],
    );
    await runDatabasePruning();
    await resaveAttendee(capturedAttendee(attendee));

    await expectNoLegacyWarning(refund);
  });
});
