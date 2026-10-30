/* The RefundReversal checker data: every fact comes from the production
 * refund plan and ledger functions over the fixture triples, never from a
 * stored move table. The negative controls keep the safety verdicts honest. */

/* jscpd:ignore-start -- imports */
import { createClient } from "@libsql/client";
import { attendeeAccount } from "#accounting/accounts.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { execute, setDb } from "#db/client.ts";
import { rebuildWipedSchema } from "#db/migrations.ts";
import { once } from "#fp";
import {
  type ModelDataSource,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import {
  FIXTURES,
  type Fixture,
  hasRefundLegs,
  labelFor,
  mergedGroupOf,
} from "#scripts/verify-models/refund-reversal-fixtures.ts";
import {
  type Facts,
  legFields,
  ReferenceOutcomesSchema,
  type ReversalFact,
  referenceFields,
  reversalFields,
} from "#scripts/verify-models/refund-reversal-schemas.ts";
import { isInverseOf } from "#shared/ledger/reverse.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import {
  accountRefundGroups,
  type ComputedRefund,
  computeAttendeeRefunds,
  refundGroupFacts,
} from "#shared/refund-ledger/plan.ts";
import type { StoredTaxAssessment } from "#shared/tax/store.ts";

/* jscpd:ignore-end */

/* One plan's facts, derived from the plan the production function returned
 * for the fixture's current ledger legs. */
const planFacts = (
  fixture: Fixture,
  currentLegs: readonly TransferInput[],
  computed: ComputedRefund,
): Facts => {
  const groups = accountRefundGroups(
    currentLegs as Transfer[],
    fixture.assessments,
  );
  const posted = computed.groups.flat();
  const reversed = new Set(
    posted
      .map((leg) => mergedGroupOf(fixture, leg.reversesGroup))
      .filter((group) => group.length > 0),
  );
  const account = attendeeAccount(fixture.attendeeId);
  return {
    legs: posted.map((leg) => ({
      exactInverse: currentLegs.some(
        (original) =>
          original.eventGroup === leg.reversesGroup &&
          isInverseOf(leg, original),
      ),
      group: labelFor(fixture, mergedGroupOf(fixture, leg.reversesGroup)),
    })),
    references: fixture.references.map((reference) => ({
      outcome: computed.result.recorded.has(reference.index)
        ? "recorded"
        : computed.result.reviewReferenceIndexes.has(reference.index)
          ? "review"
          : "unrecorded",
      reference: reference.index,
    })),
    reversals: groups.map((group) => ({
      ...refundGroupFacts(account, group),
      alreadyRecorded: hasRefundLegs(fixture, currentLegs, group.eventGroup),
      group: labelFor(fixture, group.eventGroup),
      reverses: reversed.has(group.eventGroup),
    })),
  };
};

const mergeFacts = (target: Facts, source: Facts): Facts => ({
  legs: [...target.legs, ...source.legs],
  references: [...target.references, ...source.references],
  reversals: [...target.reversals, ...source.reversals],
});

const postFixture = async (fixture: Fixture): Promise<void> => {
  const groups = [
    ...Map.groupBy(fixture.legs, (leg) => leg.eventGroup).values(),
  ];
  await postTransferGroups(groups);
  for (const record of fixture.assessments) {
    await postAssessment(record);
  }
};

const postAssessment = async (record: StoredTaxAssessment): Promise<void> => {
  const { assessment, kind, revision } = record.state;
  await execute(
    "INSERT INTO booking_tax_assessments (booking_group, revision, attendee_id, event_group, state, assessment, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      record.bookingGroup,
      revision,
      record.attendeeId,
      record.eventGroup,
      kind,
      JSON.stringify(assessment),
      record.occurredAt,
    ],
  );
};

/* The whole derivation runs against one throwaway ledger, so every fact is
 * the production function's live output over the fixture triples. */
const bootLedger = once(async (): Promise<() => Promise<void>> => {
  const client = createClient({
    url: `file:${await Deno.makeTempFile({ suffix: ".db" })}`,
  });
  setDb(client);
  await rebuildWipedSchema();
  return async () => {
    setDb(null);
    client.close();
  };
});

const planFor = async (fixture: Fixture): Promise<ComputedRefund> => {
  const plan = (
    await computeAttendeeRefunds([
      { attendeeId: fixture.attendeeId, references: fixture.references },
    ])
  )[0];
  if (!plan)
    throw new Error(`Missing refund plan for attendee ${fixture.attendeeId}`);
  return plan;
};

const deriveFacts = once(async (): Promise<Facts> => {
  const teardown = await bootLedger();
  let facts: Facts = { legs: [], references: [], reversals: [] };
  for (const fixture of FIXTURES) {
    await postFixture(fixture);
    const current = fixture.legs;
    const first = await planFor(fixture);
    facts = mergeFacts(facts, planFacts(fixture, current, first));
    if (fixture.replay) {
      await postTransferGroups([first.groups.flat()]);
      const replay = await planFor(fixture);
      facts = mergeFacts(
        facts,
        planFacts(fixture, [...current, ...first.groups.flat()], replay),
      );
    }
  }
  await teardown();
  return facts;
});

const moduleFor = (facts: Facts): string =>
  tlaModule("RefundReversalData", [
    tlaRecords("ReversalFacts", reversalFields, facts.reversals),
    tlaRecords("LegFacts", legFields, facts.legs),
    tlaRecords("ReferenceFacts", referenceFields, facts.references),
    `ReferenceOutcomes == ${tlaSet(ReferenceOutcomesSchema.options)}`,
  ]);

/** One fact set changed by `change`, kept in the checker record shape.
 * Shared by the negative controls, each of which corrupts one field. */
const changedFacts = <Key extends keyof Facts>(
  facts: Facts,
  field: Key,
  change: (fact: Facts[Key][number], index: number) => Facts[Key][number],
): Facts => ({ ...facts, [field]: facts[field].map(change) });

/** A negative control over the clean facts: one reversal decision changed to
 * reverse. The checker must reject the result. */
const reversalControl =
  (match: (reversal: ReversalFact) => boolean): ModelDataSource =>
  async () =>
    moduleFor(
      changedFacts(await deriveFacts(), "reversals", (reversal) =>
        match(reversal) ? { ...reversal, reverses: true } : reversal,
      ),
    );

/** The clean proof data. The check must pass. */
export const refundReversalModelData: ModelDataSource = async () =>
  moduleFor(await deriveFacts());

/** The negative control for an operator-money reversal: a group that carries
 *  operator money reverses. The checker must reject it. */
export const operatorMoneyReversalData: ModelDataSource = reversalControl(
  (reversal) => reversal.group === "operator",
);

/** The negative control for a leg that is not the exact inverse of its
 *  original: one posted refund leg reverses nothing it records. The checker
 *  must reject it. */
export const nonInverseLegData: ModelDataSource = async () =>
  moduleFor(
    changedFacts(await deriveFacts(), "legs", (leg, index) =>
      index === 0 ? { ...leg, exactInverse: false } : leg,
    ),
  );

/** The negative control for a double record: a group the ledger already
 *  records reverses again, so the refund credits twice. The checker must
 *  reject it. */
export const doubleRecordData: ModelDataSource = reversalControl(
  (reversal) => reversal.group === "safe" && reversal.alreadyRecorded,
);
