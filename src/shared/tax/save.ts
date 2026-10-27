/* jscpd:ignore-start */
import { attendeeAccount, MODIFIER, REVENUE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { eventGroup } from "#accounting/refs.ts";
import { insertStatement, selectTransfersScope } from "#accounting/rows.ts";
import {
  queryBatchPrimary,
  queryOnePrimary,
  type SqlStatement,
} from "#db/client.ts";
import { parseTaxPolicy } from "#db/settings/tax.ts";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import { taxCorrectionLegs } from "#shared/tax/corrections.ts";
import {
  readTaxAssessments,
  type StoredTaxAssessment,
  taxAssessmentGuard,
  taxRevisionFence,
  taxRevisionGroup,
  taxStateInsert,
} from "#shared/tax/store.ts";
import { reassessTax } from "#shared/tax/transitions.ts";
import { NO_TAX, type TaxBasis, type TaxPolicy } from "#shared/tax/types.ts";
/* jscpd:ignore-end */

export type TaxSavePreview = {
  token: string;
  policy: TaxPolicy;
  changed: boolean;
  beforeTax: number;
  afterTax: number;
  beforeBalance: number;
  afterBalance: number;
};
export type TaxSavePlan = {
  preview: TaxSavePreview;
  before: SqlStatement[];
  after: SqlStatement[];
};

const originalBasis = (legs: readonly Transfer[]): TaxBasis => ({
  lines: legs
    .filter((leg) => leg.kind === KIND.sale && leg.destination.type === REVENUE)
    .map((leg) => ({
      gross: leg.amount,
      listingId: Number(leg.destination.id),
    })),
  modifiers: legs
    .filter((leg) => leg.kind === KIND.modifier)
    .map((leg) => ({
      delta: leg.source.type === MODIFIER ? -leg.amount : leg.amount,
      modifierId: Number(
        leg.source.type === MODIFIER ? leg.source.id : leg.destination.id,
      ),
    })),
});

const addLegacyAssessments = (
  attendeeId: number,
  legs: readonly Transfer[],
  latest: Map<string, StoredTaxAssessment>,
): void => {
  const originals = Map.groupBy(
    legs.filter((leg) => leg.kind === KIND.sale || leg.kind === KIND.modifier),
    (leg) => leg.eventGroup,
  );
  for (const [bookingGroup, original] of originals) {
    if (latest.has(bookingGroup)) continue;
    const assessment = assessTax(originalBasis(original), NO_TAX);
    latest.set(bookingGroup, {
      attendeeId,
      bookingGroup,
      eventGroup: bookingGroup,
      occurredAt: original[0]!.occurredAt,
      state: {
        assessment,
        kind: legs.some((leg) => leg.reversesGroup === bookingGroup)
          ? "refunded"
          : "active",
        revision: 0,
      },
    });
  }
};

/** Primary reads plus commit fences keep previews separate from authority. */
export const buildTaxSavePlan = async (
  attendeeId: number,
): Promise<TaxSavePlan> => {
  const stored = await readTaxAssessments([attendeeId]);
  const legs = await selectTransfersScope(queryBatchPrimary, (bind) => {
    const id = bind(String(attendeeId));
    return `(source_type = 'attendee' AND source_id = ${id}) OR (dest_type = 'attendee' AND dest_id = ${id})`;
  });
  const setting = await queryOnePrimary<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'tax'",
    [],
  );
  const rawPolicy = setting?.value ?? "";
  const policy = parseTaxPolicy(rawPolicy);
  const account = attendeeAccount(attendeeId);
  const latest = new Map(stored.map((record) => [record.bookingGroup, record]));
  const persisted = new Set(latest.keys());
  addLegacyAssessments(attendeeId, legs, latest);
  const beforeBalance = -balanceOf(account)(legs);
  const highWater = legs.reduce((last, leg) => Math.max(last, leg.id), 0);
  const token = await eventGroup([
    "tax-save",
    attendeeId,
    highWater,
    legs.length,
    beforeBalance,
    rawPolicy,
    JSON.stringify(
      stored.map((record) => [record.bookingGroup, record.state.revision]),
    ),
  ]);
  const before: SqlStatement[] = [
    taxAssessmentGuard({
      args: [rawPolicy],
      sql: "COALESCE((SELECT value FROM settings WHERE key = 'tax'), '') = ?",
    }),
    taxAssessmentGuard({
      args: [
        highWater,
        legs.length,
        String(attendeeId),
        -beforeBalance,
        String(attendeeId),
        String(attendeeId),
      ],
      sql: `(SELECT COALESCE(MAX(transfer.id), 0) = ? AND COUNT(*) = ? AND COALESCE(SUM(CASE WHEN transfer.dest_type = 'attendee' AND transfer.dest_id = ? THEN transfer.amount ELSE -transfer.amount END), 0) = ? FROM transfers AS transfer WHERE (transfer.source_type = 'attendee' AND transfer.source_id = ?) OR (transfer.dest_type = 'attendee' AND transfer.dest_id = ?))`,
    }),
    taxAssessmentGuard({
      args: [attendeeId, stored.length],
      sql: "(SELECT COUNT(*) FROM booking_tax_assessments AS assessment WHERE assessment.attendee_id = ?) = ?",
    }),
    taxAssessmentGuard({
      args: [attendeeId, CLAIM_MIRROR],
      sql: "NOT EXISTS (SELECT 1 FROM processed_payments AS payment WHERE payment.attendee_id = ? AND payment.protected_state = ?)",
    }),
  ];
  const after: SqlStatement[] = [];
  const occurredAt = nowIso();
  let beforeTax = 0;
  let afterTax = 0;
  let totalDelta = 0;
  let changed = false;
  for (const record of latest.values()) {
    before.push(
      taxAssessmentGuard(
        taxRevisionFence(
          record.bookingGroup,
          persisted.has(record.bookingGroup) ? record.state.revision : -1,
          record.attendeeId,
        ),
      ),
    );
    if (!persisted.has(record.bookingGroup))
      after.push(await taxStateInsert(record));
    if (record.state.kind === "refunded") continue;
    const transition = reassessTax(record.state, policy, record.state.revision);
    beforeTax += record.state.assessment.taxAmount;
    afterTax += transition.after.assessment.taxAmount;
    totalDelta +=
      transition.after.assessment.total - record.state.assessment.total;
    if (transition.kind === "unchanged") continue;
    changed = true;
    const correction = await taxCorrectionLegs(
      attendeeId,
      record.bookingGroup,
      transition.after.revision,
      transition.before.assessment,
      transition.after.assessment,
      occurredAt,
      "system",
    );
    after.push(...correction.map((leg) => insertStatement(leg, occurredAt)));
    const revised: StoredTaxAssessment = {
      ...record,
      eventGroup: await taxRevisionGroup(
        record.bookingGroup,
        transition.after.revision,
      ),
      occurredAt,
      state: transition.after,
    };
    after.push(await taxStateInsert(revised));
  }
  return {
    after,
    before,
    preview: {
      afterBalance: beforeBalance + totalDelta,
      afterTax,
      beforeBalance,
      beforeTax,
      changed,
      policy,
      token,
    },
  };
};
