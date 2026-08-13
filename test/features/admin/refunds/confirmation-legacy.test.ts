import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { confirmRefund } from "#routes/admin/refunds/confirmation.ts";
import { queryOne } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  legacyRefundWarnings,
} from "#shared/payment/placeholder-refund.ts";
import { requireValue } from "#shared/required-value.ts";
import type { Attendee } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { withTestSession } from "#test-utils/session.ts";
import {
  type ConfirmationFixture,
  DEFAULT_PAYMENT,
  setupConfirmation,
} from "./confirmation-fixture.ts";

const createLegacyWarning = (attendee: Attendee): Promise<void> =>
  createSystemNote(
    attendeeNotes(attendee.id),
    requireValue(
      [...legacyRefundWarnings(attendee.id, DEFAULT_PAYMENT.paymentReference)][0],
      "The legacy warning schema needs one message",
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
    anchorOnly: true,
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
  test("retires an exact unnamed warning through bounded attendee-only pages", async () => {
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      anchorOnly: true,
      beforeClaim: async (attendee) => {
        const target = attendeeNotes(attendee.id);
        for (let index = 0; index < 40; index++) {
          await createSystemNote(target, `Unrelated imported note ${index}`);
        }
        await createLegacyWarning(attendee);
        await createSystemNote(
          target,
          `Imported provider note for ${DEFAULT_PAYMENT.paymentReference}; keep this history.`,
        );
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
    expect(beforeConfirmation).toHaveLength(42);
    expect(refund.references).toHaveLength(1);
    const storedPayments = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM processed_payments AS payment
        WHERE payment.attendee_id = ?`,
      [refund.attendee.id],
    );
    expect(storedPayments?.count).toBe(1);

    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      expect(
        await withTestSession(() =>
          confirmRefund({ ...refund, references: [refund.reference] }),
        ),
      ).toBe("new");
    } finally {
      restore();
    }

    const legacyReads = queries.filter(
      (sql) =>
        sql.includes("FROM system_notes AS note") &&
        sql.includes("note.id > ?"),
    );
    expect(legacyReads).toHaveLength(3);
    expect(legacyReads.every((sql) => sql.includes("LIMIT ?"))).toBe(true);
    expect(legacyReads.every((sql) => !sql.includes("pii_blob"))).toBe(true);

    const notes = (await getNotesFor(target, refund.privateKey)).map(
      (note) => note.note,
    );
    expect(notes).toHaveLength(42);
    expect(notes).toContain("Unrelated imported note 0");
    expect(notes).toContain("Unrelated imported note 39");
    expect(notes).toContain(
      `Imported provider note for ${refund.reference.reference}; keep this history.`,
    );
    expect(notes).toContain(t("note.placeholder_refund_confirmed"));
    expect(notes.some((note) => note.includes("could NOT be refunded"))).toBe(
      false,
    );
  });

  test("does not scan note history for a current payment", async () => {
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      beforeClaim: createLegacyWarning,
      paymentId: DEFAULT_PAYMENT.paymentReference,
    });
    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      expect(
        await withTestSession(() =>
          confirmRefund({ ...refund, references: [refund.reference] }),
        ),
      ).toBe("new");
    } finally {
      restore();
    }

    expect(
      queries.some(
        (sql) =>
          sql.includes("FROM system_notes AS note") &&
          sql.includes("note.id > ?"),
      ),
    ).toBe(false);
  });

  test("replay keeps the retired anchor warning gone", async () => {
    const { refund } = await setupLegacyWarningConfirmation();
    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("new");
    expect(
      await withTestSession(() =>
        confirmRefund({ ...refund, references: [refund.reference] }),
      ),
    ).toBe("current");
    await expectNoLegacyWarning(refund);
  });
});
