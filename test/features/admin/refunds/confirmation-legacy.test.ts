import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { queryOne } from "#shared/db/client.ts";
import { createSystemNote, getNotesFor } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import type { Attendee } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import {
  type ConfirmationFixture,
  confirmFixturePayment,
  confirmFixturePaymentAndReplay,
  DEFAULT_PAYMENT,
  setupConfirmation,
} from "./confirmation-fixture.ts";

const createLegacyWarning = (attendee: Attendee): Promise<void> =>
  createSystemNote(
    attendeeNotes(attendee.id),
    `This booking was kept at quantity 0 but its payment could NOT be refunded automatically because the event filled up while they were paying. Payment reference: ${DEFAULT_PAYMENT.paymentReference} (code: capacity_full). Please refund it manually and check the [ledger](/admin/ledger/attendee/${attendee.id}).`,
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

const expectLegacyWarning = async (
  refund: Pick<ConfirmationFixture, "attendee" | "privateKey">,
): Promise<void> => {
  expect(
    (
      await getNotesFor(attendeeNotes(refund.attendee.id), refund.privateKey)
    ).filter((note) => note.note.includes("could NOT be refunded")),
  ).toHaveLength(1);
};

const captureNewConfirmationQueries = async (
  refund: ConfirmationFixture,
): Promise<string[]> => {
  const queries: string[] = [];
  const restore = recordQueries(queries);
  try {
    expect(await confirmFixturePayment(refund)).toBe("new");
  } finally {
    restore();
  }
  return queries;
};

describeWithEnv("admin refunds > legacy confirmation", { db: true }, () => {
  test("confirms old money without scanning historical unnamed notes", async () => {
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      anchorOnly: true,
      beforeClaim: async (attendee) => {
        const target = attendeeNotes(attendee.id);
        for (let index = 0; index < 100; index++) {
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
    expect(beforeConfirmation).toHaveLength(102);
    expect(refund.references).toHaveLength(1);
    const storedPayments = await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM processed_payments AS payment
        WHERE payment.attendee_id = ?`,
      [refund.attendee.id],
    );
    expect(storedPayments?.count).toBe(1);

    const queries = await captureNewConfirmationQueries(refund);

    const legacyReads = queries.filter((sql) =>
      sql.includes("FROM system_notes AS note"),
    );
    expect(legacyReads).toEqual([]);

    const notes = (await getNotesFor(target, refund.privateKey)).map(
      (note) => note.note,
    );
    expect(notes).toHaveLength(103);
    expect(notes).toContain("Unrelated imported note 0");
    expect(notes).toContain("Unrelated imported note 99");
    expect(notes).toContain(
      `Imported provider note for ${refund.reference.reference}; keep this history.`,
    );
    expect(notes).toContain(t("note.placeholder_refund_confirmed"));
    const legacyWarnings = notes.filter((note) =>
      note.includes("could NOT be refunded"),
    );
    expect(legacyWarnings).toHaveLength(1);
    expect(legacyWarnings[0]).toContain(DEFAULT_PAYMENT.paymentReference);
  });

  test("does not scan note history for a current payment", async () => {
    const refund = await setupConfirmation([DEFAULT_PAYMENT], {
      beforeClaim: createLegacyWarning,
      paymentId: DEFAULT_PAYMENT.paymentReference,
    });
    const queries = await captureNewConfirmationQueries(refund);

    expect(
      queries.some(
        (sql) =>
          sql.includes("FROM system_notes AS note") &&
          sql.includes("note.id > ?"),
      ),
    ).toBe(false);
  });

  test("replay leaves the historical unnamed warning untouched", async () => {
    const { refund } = await setupLegacyWarningConfirmation();
    expect(await confirmFixturePaymentAndReplay(refund)).toEqual([
      "new",
      "current",
    ]);
    await expectLegacyWarning(refund);
  });
});
