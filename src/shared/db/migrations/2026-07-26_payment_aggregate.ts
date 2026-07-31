import * as v from "valibot";
import { mapParallel } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  LegacyAttendeePaymentSchema,
  type LegacyCheckoutStage,
  LegacyCheckoutStageSchema,
  type LegacyPaymentGroup,
  LegacyProcessedPaymentSchema,
  LegacySumupCheckoutSchema,
  mergeLegacyPaymentRows,
} from "#shared/db/payments/legacy.ts";
import {
  legacySourceStatements,
  legacyTargetStatements,
  prepareLegacyPayment,
} from "#shared/db/payments/legacy-copy.ts";
import { verifyLegacyPayments } from "#shared/db/payments/legacy-verify.ts";
import { bareSchemaMigration } from "./define.ts";
import { MigrationInProgressError } from "./errors.ts";
import {
  assertLegacyPaymentSourcesDrained,
  blockLegacyPaymentWrites,
  existingLegacyPaymentTables,
} from "./legacy-payment-retirement.ts";
import type { LegacyPaymentTableName } from "./legacy-payment-schema.ts";
import type { MigrationContext } from "./types.ts";

const parseRows = <TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  rows: Iterable<unknown>,
): TOutput[] => [...rows].map((row) => v.parse(schema, row));

const MIGRATION_PAGE_SIZE = 25;
const MIGRATION_PAGES_PER_INVOCATION = 2;

const sourceIds = async (
  getDb: MigrationContext["getDb"],
  existing: ReadonlySet<LegacyPaymentTableName>,
): Promise<string[]> => {
  const sources = [
    ...(existing.has("processed_payments")
      ? [
          "SELECT payment_session_id AS paymentSessionId FROM processed_payments",
        ]
      : []),
    ...(existing.has("checkout_stages")
      ? ["SELECT payment_session_id AS paymentSessionId FROM checkout_stages"]
      : []),
  ];
  if (sources.length === 0) return [];
  const result = await getDb().execute({
    args: [MIGRATION_PAGE_SIZE],
    sql: `SELECT paymentSessionId FROM (${sources.join(" UNION ")})
      ORDER BY paymentSessionId LIMIT ?`,
  });
  return result.rows.map((row) => v.parse(v.string(), row.paymentSessionId));
};

const placeholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");

const readLegacySessionPage = async (
  getDb: MigrationContext["getDb"],
  existing: ReadonlySet<LegacyPaymentTableName>,
): Promise<LegacyPaymentGroup[]> => {
  const ids = await sourceIds(getDb, existing);
  if (ids.length === 0) return [];
  const slots = placeholders(ids);
  const processedRows = existing.has("processed_payments")
    ? (
        await getDb().execute({
          args: ids,
          sql: `SELECT
            payment_session_id AS paymentSessionId,
            attendee_id AS attendeeId,
            -- Any booking names the listing, including one refunded down to
            -- no quantity. Skipping those would leave a paid record with a
            -- buyer and no listing, which the upgrade refuses to write.
            CASE WHEN attendee_id IS NULL THEN NULL ELSE (
              SELECT booking.listing_id FROM listing_attendees AS booking
               WHERE booking.attendee_id = processedPayment.attendee_id
               ORDER BY booking.quantity > 0 DESC, booking.id LIMIT 1
            ) END AS listingId,
            processed_at AS processedAt,
            ticket_tokens AS ticketTokens,
            failure_data AS failureData,
            payment_reference AS paymentReference,
            provider_refunded_at AS providerRefundedAt
            FROM processed_payments AS processedPayment
            WHERE processedPayment.payment_session_id IN (${slots})
            ORDER BY processedPayment.payment_session_id`,
        })
      ).rows
    : [];
  const stageRows = existing.has("checkout_stages")
    ? parseRows(
        LegacyCheckoutStageSchema,
        (
          await getDb().execute({
            args: ids,
            sql: `SELECT
              payment_session_id AS paymentSessionId,
              attendee_id AS attendeeId,
              provider,
              ticket_tokens AS ticketTokens,
              state,
              created_at AS createdAt
              FROM checkout_stages AS checkoutStage
              WHERE checkoutStage.payment_session_id IN (${slots})
              ORDER BY checkoutStage.payment_session_id`,
          })
        ).rows,
      )
    : [];
  const referenceIndexes = await mapParallel((stage: LegacyCheckoutStage) =>
    hmacHash(stage.paymentSessionId),
  )(stageRows.filter((stage) => stage.provider === "sumup"));
  const sumupArgs = [...ids, ...referenceIndexes];
  const sumupRows = existing.has("sumup_checkouts")
    ? (
        await getDb().execute({
          args: sumupArgs,
          sql: `SELECT
            reference_index AS referenceIndex,
            wrapped_key AS wrappedKey,
            metadata,
            sumup_id AS sumupId,
            created_at AS createdAt
            FROM sumup_checkouts AS sumupCheckout
            WHERE sumupCheckout.sumup_id IN (${slots})
              ${
                referenceIndexes.length === 0
                  ? ""
                  : `OR sumupCheckout.reference_index IN (${placeholders(
                      referenceIndexes,
                    )})`
              }
            ORDER BY sumupCheckout.reference_index`,
        })
      ).rows
    : [];
  return await mergeLegacyPaymentRows({
    attendeePayments: [],
    checkoutStages: stageRows,
    processedPayments: parseRows(LegacyProcessedPaymentSchema, processedRows),
    sumupCheckouts: parseRows(LegacySumupCheckoutSchema, sumupRows),
  });
};

const readLegacySumupPage = async (
  getDb: MigrationContext["getDb"],
  existing: ReadonlySet<LegacyPaymentTableName>,
): Promise<LegacyPaymentGroup[]> => {
  if (!existing.has("sumup_checkouts")) return [];
  const result = await getDb().execute({
    args: [MIGRATION_PAGE_SIZE],
    sql: `SELECT reference_index AS referenceIndex, wrapped_key AS wrappedKey,
        metadata, sumup_id AS sumupId, created_at AS createdAt
      FROM sumup_checkouts AS sumupCheckout
      ORDER BY sumupCheckout.reference_index LIMIT ?`,
  });
  return await mergeLegacyPaymentRows({
    attendeePayments: [],
    checkoutStages: [],
    processedPayments: [],
    sumupCheckouts: parseRows(LegacySumupCheckoutSchema, result.rows),
  });
};

const readLegacyAttendeePage = async (
  getDb: MigrationContext["getDb"],
): Promise<LegacyPaymentGroup[]> => {
  const result = await getDb().execute({
    args: [MIGRATION_PAGE_SIZE],
    sql: `SELECT attendee.id AS attendeeId, attendee.created AS createdAt,
        attendee.pii_blob AS paymentReference,
        'attendees.pii_blob' AS source
      FROM attendees AS attendee
      WHERE attendee.pii_blob LIKE 'hyb:1:%'
        AND EXISTS (
          SELECT 1 FROM transfers AS paymentLeg
          WHERE paymentLeg.kind = 'payment'
            AND paymentLeg.dest_type = 'attendee'
            AND paymentLeg.dest_id = CAST(attendee.id AS TEXT)
        )
        AND NOT EXISTS (
          SELECT 1 FROM payment_sessions AS paymentSession
          WHERE paymentSession.attendee_id = attendee.id
        )
      ORDER BY attendee.id LIMIT ?`,
  });
  return await mergeLegacyPaymentRows({
    attendeePayments: parseRows(LegacyAttendeePaymentSchema, result.rows),
    checkoutStages: [],
    processedPayments: [],
    sumupCheckouts: [],
  });
};

const copyPage = async (
  getDb: MigrationContext["getDb"],
  groups: LegacyPaymentGroup[],
  drain: boolean,
): Promise<void> => {
  const payments = await mapParallel(prepareLegacyPayment)(groups);
  await getDb().batch(payments.flatMap(legacyTargetStatements), "write");
  await verifyLegacyPayments(payments);
  if (!drain) return;
  const deleted = await getDb().batch(
    payments.flatMap((payment) => legacySourceStatements(payment.runtime)),
    "write",
  );
  if (deleted.some((result) => result.rowsAffected !== 1)) {
    throw new Error("A legacy payment changed before it could be drained");
  }
};

type LegacyPageReader = () => Promise<LegacyPaymentGroup[]>;

interface CopiedPages {
  complete: boolean;
  count: number;
}

const copyAvailablePages = async (
  readPage: LegacyPageReader,
  drain: boolean,
  limit: number,
  getDb: MigrationContext["getDb"],
): Promise<CopiedPages> => {
  if (limit === 0) {
    return { complete: (await readPage()).length === 0, count: 0 };
  }
  for (let count = 0; count < limit; count += 1) {
    const page = await readPage();
    if (page.length === 0) return { complete: true, count };
    await copyPage(getDb, page, drain);
    if (page.length < MIGRATION_PAGE_SIZE) {
      return { complete: true, count: count + 1 };
    }
  }
  return { complete: false, count: limit };
};

const requireAnotherInvocation = (): never => {
  throw new MigrationInProgressError(
    "Legacy payment migration is continuing on the next request.",
  );
};

const migrateLegacyPayments = async (
  getDb: MigrationContext["getDb"],
): Promise<void> => {
  const existing = await existingLegacyPaymentTables(getDb);
  await blockLegacyPaymentWrites(getDb, existing);
  let remaining = MIGRATION_PAGES_PER_INVOCATION;
  const sessions = await copyAvailablePages(
    () => readLegacySessionPage(getDb, existing),
    true,
    remaining,
    getDb,
  );
  if (!sessions.complete) return requireAnotherInvocation();
  remaining -= sessions.count;
  const sumup = await copyAvailablePages(
    () => readLegacySumupPage(getDb, existing),
    true,
    remaining,
    getDb,
  );
  if (!sumup.complete) return requireAnotherInvocation();
  remaining -= sumup.count;
  await assertLegacyPaymentSourcesDrained(getDb, existing);
  const attendees = await copyAvailablePages(
    () => readLegacyAttendeePage(getDb),
    false,
    remaining,
    getDb,
  );
  if (!attendees.complete) return requireAnotherInvocation();
};

// The tables this fills are made by 2026-07-26_payment_records, so this one
// owns no schema of its own — only the copy of the old payment rows into them.
export default bareSchemaMigration(
  "2026-07-26_payment_aggregate",
  "Copy the old payment rows into the durable payment tables.",
  async ({ getDb }) => migrateLegacyPayments(getDb),
);
