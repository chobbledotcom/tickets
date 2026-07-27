import { getDb } from "#shared/db/client.ts";
import paymentAggregateMigration from "#shared/db/migrations/2026-07-26_payment_aggregate.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import { createLegacyPaymentTables } from "#shared/db/migrations/legacy-payment-schema.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { additive } from "#shared/db/migrations/verify.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

export const context = buildMigrationContext({
  additive,
  applySchemaChanges,
  syncIndexes,
});

export const runMigrationInvocation = async (): Promise<void> => {
  const migration = paymentAggregateMigration(context);
  await migration.up();
  await migration.verify();
};

export const runMigration = async (): Promise<void> => {
  for (;;) {
    try {
      await runMigrationInvocation();
      return;
    } catch (error) {
      if (!(error instanceof MigrationInProgressError)) throw error;
    }
  }
};

export const restoreLegacyPaymentSources = (): Promise<void> =>
  createLegacyPaymentTables(getDb);

export const insertProcessedRow = async (
  fields: { attendeeId?: number | null; failureData?: string } = {},
): Promise<void> => {
  await getDb().execute({
    args: [
      "one-processed-payment",
      fields.attendeeId ?? null,
      "2026-07-25T10:00:00.000Z",
      fields.failureData ?? "",
    ],
    sql: `INSERT INTO processed_payments
      (payment_session_id, attendee_id, processed_at, failure_data)
      VALUES (?, ?, ?, ?)`,
  });
};

export const seedLegacyPaidAttendee = async (): Promise<void> => {
  await getDb().batch(
    [
      {
        args: [
          42,
          "2026-07-25T09:00:00.000Z",
          "hyb:1:legacy-pii",
          "legacy-token",
        ],
        sql: `INSERT INTO attendees (id, created, pii_blob, ticket_token_index)
          VALUES (?, ?, ?, ?)`,
      },
      {
        args: [],
        sql: `INSERT INTO listing_attendees
          (listing_id, attendee_id, quantity) VALUES (7, 42, 1)`,
      },
    ],
    "write",
  );
};
