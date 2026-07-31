import { encrypt } from "#shared/crypto/encryption.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { getDb } from "#shared/db/client.ts";
import paymentAggregateMigration from "#shared/db/migrations/2026-07-26_payment_aggregate.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { additive } from "#shared/db/migrations/verify.ts";
import { settings } from "#shared/db/settings.ts";
import { createLegacyPaymentTables } from "#test-utils/legacy-payment-tables.ts";
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
          "hyb:1:key:iv:legacy-pii",
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

/** Comfortably more rows than the migration will copy in one go. The exact
 *  page size is the migration's own business, so this only has to be large
 *  enough that it cannot finish in a single request. */
export const MORE_THAN_ONE_INVOCATION = 200;

/** Seed many SumUp checkouts in a single batch — the migration only cares how
 *  many there are, so one write beats running the real path fifty times. */
export const seedSumupCheckouts = async (count: number): Promise<void> => {
  const metadata = await encrypt('{"private":"metadata"}');
  await getDb().batch(
    Array.from({ length: count }, (_unused, index) => ({
      args: [
        `bulk-reference-${index}`,
        "wk:1:bulk-key",
        metadata,
        `bulk-sumup-${index}`,
        "2026-07-25T12:00:00.000Z",
      ],
      sql: `INSERT INTO sumup_checkouts
        (reference_index, wrapped_key, metadata, sumup_id, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    })),
    "write",
  );
};

/** Seed many old attendee-only payments in a single batch. Each needs the
 *  encrypted details and a payment leg for the migration to notice it. */
export const seedLegacyPaidAttendees = async (count: number): Promise<void> => {
  const piiBlob = await encryptPiiBlob(
    buildPiiBlob({
      address: "",
      email: "bulk@example.com",
      lat: "",
      lng: "",
      name: "Bulk attendee",
      payment_id: "pi_bulk",
      phone: "",
      special_instructions: "",
      ticket_token: "bulk-ticket",
    }),
    settings.publicKey,
  );
  await getDb().batch(
    Array.from({ length: count }, (_unused, index) => index + 1).flatMap(
      (id) => [
        {
          args: [id, "2026-07-25T09:00:00.000Z", piiBlob, `bulk-index-${id}`],
          sql: `INSERT INTO attendees (id, created, pii_blob, ticket_token_index)
            VALUES (?, ?, ?, ?)`,
        },
        {
          args: [String(id), `bulk-payment-leg-${id}`],
          sql: `INSERT INTO transfers
            (source_type, source_id, dest_type, dest_id, amount, occurred_at,
             recorded_at, reference, event_group, kind)
            VALUES ('external', 'world', 'attendee', ?, 1000, 1, 1, ?,
              'legacy-order', 'payment')`,
        },
      ],
    ),
    "write",
  );
};
