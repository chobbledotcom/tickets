/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { eventGroup } from "#accounting/refs.ts";
import type { SqlStatement, TxScope } from "#db/client.ts";
import { notNullGuardFailure, rowsByIdsPrimary } from "#db/query.ts";
import { col, defineTable } from "#db/table.ts";
import { refundTax, type TaxState } from "#shared/tax/transitions.ts";
import { type TaxAssessment, TaxAssessmentSchema } from "#shared/tax/types.ts";

/* jscpd:ignore-end */

interface AssessmentRow {
  assessment: TaxAssessment;
  attendee_id: number;
  booking_group: string;
  event_group: string;
  occurred_at: string;
  revision: number;
  state: TaxState["kind"];
}
interface AssessmentInput {
  assessment: TaxAssessment;
  attendeeId: number;
  bookingGroup: string;
  eventGroup: string;
  occurredAt: string;
  revision: number;
  state: TaxState["kind"];
}
const table = defineTable<AssessmentRow, AssessmentInput>({
  name: "booking_tax_assessments",
  primaryKey: "event_group",
  schema: {
    assessment: col.json(TaxAssessmentSchema, {
      context: "Booking tax assessment",
    }),
    attendee_id: col.simple(),
    booking_group: col.simple(),
    event_group: col.simple(),
    occurred_at: col.simple(),
    revision: col.simple(),
    state: col.simple(),
  },
});

export type StoredTaxAssessment = {
  bookingGroup: string;
  attendeeId: number;
  eventGroup: string;
  occurredAt: string;
  state: TaxState;
};

/** A pre-VAT booking has no assessment until its first explicit save. */
export const readTaxAssessments = async (
  attendeeIds: readonly number[],
): Promise<StoredTaxAssessment[]> => {
  const rows = await rowsByIdsPrimary<AssessmentRow>(
    [...attendeeIds],
    (ids) =>
      `SELECT ${table.columns.join(", ")} FROM booking_tax_assessments WHERE attendee_id IN (${ids}) ORDER BY booking_group, revision`,
  );
  return Promise.all(
    rows.map(async (raw) => {
      const row = await table.fromDb(raw);
      return {
        attendeeId: row.attendee_id,
        bookingGroup: row.booking_group,
        eventGroup: row.event_group,
        occurredAt: row.occurred_at,
        state: {
          assessment: row.assessment,
          kind: row.state,
          revision: row.revision,
        },
      };
    }),
  );
};

export const taxRevisionGroup = (
  bookingGroup: string,
  revision: number,
): Promise<string> => eventGroup(["tax-assessment", bookingGroup, revision]);

/** A failed condition aborts the whole domain-and-ledger batch. */
export const taxAssessmentGuard = (condition: SqlStatement): SqlStatement => ({
  args: condition.args,
  sql: `INSERT INTO booking_tax_assessments (booking_group) SELECT NULL WHERE NOT (${condition.sql})`,
});

export const taxRevisionFence = (
  bookingGroup: string,
  revision: number,
  attendeeId: number,
): SqlStatement => ({
  args: [bookingGroup, attendeeId, revision],
  sql: "COALESCE((SELECT MAX(assessment.revision) FROM booking_tax_assessments AS assessment WHERE assessment.booking_group = ? AND assessment.attendee_id = ?), -1) = ?",
});

export const taxStateInsert = (
  record: StoredTaxAssessment,
): Promise<SqlStatement> =>
  table.insertStatement({
    assessment: record.state.assessment,
    attendeeId: record.attendeeId,
    bookingGroup: record.bookingGroup,
    eventGroup: record.eventGroup,
    occurredAt: record.occurredAt,
    revision: record.state.revision,
    state: record.state.kind,
  });

export const initialTaxAssessmentStatement = async (
  bookingGroup: string,
  assessment: TaxAssessment,
  occurredAt: string,
  attendeeIdSql: string,
  attendeeIdArgs: readonly InValue[],
): Promise<SqlStatement> => {
  const values = await table.toDbValues({
    assessment,
    bookingGroup,
    eventGroup: bookingGroup,
    occurredAt,
    revision: 0,
    state: "active",
  });
  return {
    args: [
      values.booking_group!,
      ...attendeeIdArgs,
      values.event_group!,
      values.assessment!,
      values.occurred_at!,
    ],
    sql: `INSERT INTO booking_tax_assessments (booking_group, revision, attendee_id, event_group, state, assessment, occurred_at) SELECT ?, 0, ${attendeeIdSql}, ?, 'active', ?, ?`,
  };
};

export const postInitialTaxAssessmentTx = async (
  tx: TxScope,
  attendeeId: number,
  bookingGroup: string,
  assessment: TaxAssessment,
  occurredAt: string,
): Promise<void> => {
  await tx.execute(
    await initialTaxAssessmentStatement(
      bookingGroup,
      assessment,
      occurredAt,
      "?",
      [attendeeId],
    ),
  );
};

export const taxRefundStatements = async (
  latest: readonly StoredTaxAssessment[],
  occurredAt: string,
): Promise<SqlStatement[]> => {
  const statements: SqlStatement[] = [];
  for (const record of latest) {
    if (record.state.kind === "refunded") continue;
    const state = refundTax(record.state, record.state.revision);
    statements.push(
      taxAssessmentGuard(
        taxRevisionFence(
          record.bookingGroup,
          record.state.revision,
          record.attendeeId,
        ),
      ),
      await taxStateInsert({
        ...record,
        eventGroup: await taxRevisionGroup(record.bookingGroup, state.revision),
        occurredAt,
        state,
      }),
    );
  }
  return statements;
};

export const isTaxAssessmentConflict = (error: unknown): boolean =>
  notNullGuardFailure(error, "booking_tax_assessments.booking_group");
