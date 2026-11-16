import { eventGroup } from "#accounting/refs.ts";
import { queryAllPrimary, type TxScope } from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { abortUnless } from "#db/guarded-writes.ts";
import { notNullGuardFailureAt } from "#db/query.ts";
import { among, type Operand } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { refundTax, type TaxState } from "#shared/tax/transitions.ts";
import type { TaxAssessment } from "#shared/tax/types.ts";

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
  if (attendeeIds.length === 0) return [];
  const rows = await queryAllPrimary(
    from(tables.booking_tax_assessments)
      .where((assessment) => among(assessment.attendee_id, attendeeIds))
      .sortedBy("booking_group", "revision")
      .everyColumn(),
  );
  return rows.map((row) => ({
        attendeeId: row.attendee_id,
        bookingGroup: row.booking_group,
        eventGroup: row.event_group,
        occurredAt: row.occurred_at,
        state: {
          assessment: row.assessment,
          kind: row.state,
          revision: row.revision,
        },
  }));
};

export const taxRevisionGroup = (
  bookingGroup: string,
  revision: number,
): Promise<string> => eventGroup(["tax-assessment", bookingGroup, revision]);

/** A failed condition aborts the whole domain-and-ledger batch. */
export const taxAssessmentGuard = abortUnless(
  sql`booking_tax_assessments (booking_group)`,
  sql`NULL`,
);

export const taxRevisionFence = (
  bookingGroup: string,
  revision: number,
  attendeeId: number,
): SqlStatement =>
  sql`COALESCE((SELECT MAX(assessment.revision) FROM booking_tax_assessments AS assessment WHERE assessment.booking_group = ${bookingGroup} AND assessment.attendee_id = ${attendeeId}), -1) = ${revision}`;

export const taxStateInsert = async (
  record: StoredTaxAssessment,
): Promise<SqlStatement> =>
  insertInto(
    tables.booking_tax_assessments,
    await encoded(tables.booking_tax_assessments, {
      assessment: record.state.assessment,
      attendee_id: record.attendeeId,
      booking_group: record.bookingGroup,
      event_group: record.eventGroup,
      occurred_at: record.occurredAt,
      revision: record.state.revision,
      state: record.state.kind,
    }),
  );

export const initialTaxAssessmentStatement = async (
  bookingGroup: string,
  assessment: TaxAssessment,
  occurredAt: string,
  attendeeId: Operand<number>,
): Promise<SqlStatement> =>
  insertInto(tables.booking_tax_assessments, {
    ...(await encoded(tables.booking_tax_assessments, {
      assessment,
      booking_group: bookingGroup,
      event_group: bookingGroup,
      occurred_at: occurredAt,
      revision: 0,
      state: "active",
    })),
    attendee_id: attendeeId,
  });

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
      attendeeId,
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

export const isTaxAssessmentConflict = notNullGuardFailureAt(
  "booking_tax_assessments.booking_group",
);
