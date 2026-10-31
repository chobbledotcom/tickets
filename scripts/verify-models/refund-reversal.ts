/* The RefundReversal checker data: every fact comes from the production
 * refund plan and ledger functions over the fixture triples, never from a
 * stored move table. The negative controls keep the safety verdicts honest. */

/* jscpd:ignore-start -- imports */
import { createClient } from "@libsql/client";
import { attendeeAccount } from "#accounting/accounts.ts";
import { transfersByAccounts } from "#accounting/queries.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { execute, setDb } from "#db/client.ts";
import { rebuildWipedSchema } from "#db/migrations.ts";
import { once, requiredMapValue, unique } from "#fp";
import {
  type ModelDataSource,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import {
  type Fixture,
  fixtures,
  labelFor,
  mergedGroupOf,
  reversedGroup,
} from "#scripts/verify-models/refund-reversal-fixtures.ts";
import {
  type ExpectedReference,
  expectedReferenceFields,
  type Facts,
  type LegFact,
  legFields,
  ReferenceOutcomesSchema,
  type ReversalFact,
  type RoundName,
  RoundNamesSchema,
  referenceFields,
  reversalFields,
} from "#scripts/verify-models/refund-reversal-schemas.ts";
import { accountKey } from "#shared/ledger/account.ts";
import { isInverseOf } from "#shared/ledger/reverse.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  accountRefundGroups,
  type ComputedRefund,
  computeAttendeeRefunds,
  refundGroupFacts,
} from "#shared/refund-ledger/plan.ts";
import { requireValue } from "#shared/required-value.ts";
import type { StoredTaxAssessment } from "#shared/tax/store.ts";
import { TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";

/* jscpd:ignore-end */

/* One plan evaluation's facts, derived from the plan the production function
 * returned for the fixture's ledger legs at that round. The partition
 * universe and the original legs belong to the fixture, not to one round. */
const planFacts = (
  fixture: Fixture,
  legs: Transfer[],
  computed: ComputedRefund,
  round: RoundName,
): Omit<Facts, "expected" | "originals"> => {
  const groups = accountRefundGroups(legs, fixture.assessments);
  const posted = computed.groups.flat();
  const reversed = new Set(
    posted.map((leg) => mergedGroupOf(fixture, reversedGroup(leg))),
  );
  const account = attendeeAccount(fixture.attendeeId);
  return {
    legs: posted.map((leg) => {
      /* The recorded original the posted leg inverts, or an empty reference
       * when the plan posts a leg that inverts nothing. The checker reads the
       * empty reference as a pairing failure through OriginalLegs. */
      const original = legs.find(
        (candidate) =>
          candidate.eventGroup === leg.reversesGroup &&
          isInverseOf(leg, candidate),
      );
      return {
        exactInverse: original !== undefined,
        group: labelFor(fixture, mergedGroupOf(fixture, reversedGroup(leg))),
        original: original?.reference ?? "",
        round,
      };
    }),
    references: fixture.references.map((reference) => ({
      outcome: computed.result.recorded.has(reference.index)
        ? "recorded"
        : computed.result.reviewReferenceIndexes.has(reference.index)
          ? "review"
          : "unrecorded",
      reference: reference.index,
      round,
    })),
    reversals: groups.map((group) => ({
      ...refundGroupFacts(account, group),
      group: labelFor(fixture, group.eventGroup),
      reverses: reversed.has(group.eventGroup),
      round,
    })),
  };
};

const mergeFacts = (target: Facts, source: Facts): Facts => ({
  expected: [...target.expected, ...source.expected],
  legs: [...target.legs, ...source.legs],
  originals: [...target.originals, ...source.originals],
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
 * the production function's live output over the fixture triples. The test
 * encryption key is pinned so the event groups and the ledger reads agree
 * under any runner. */
const bootLedger = once(async (): Promise<() => Promise<void>> => {
  setEncryptionKeyForTest(TEST_ENCRYPTION_KEY);
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

/** One attendee's ledger legs, read back through the production read, so the
 * facts describe the posted rows and never the fixture's in-memory copy. */
const ledgerLegs = async (attendeeId: number): Promise<Transfer[]> => {
  const account = attendeeAccount(attendeeId);
  return requiredMapValue(
    await transfersByAccounts([account]),
    accountKey(account),
    `Refund ledger read omitted attendee ${attendeeId}`,
  );
};

const planFor = async (fixture: Fixture): Promise<ComputedRefund> =>
  requireValue(
    (
      await computeAttendeeRefunds([
        { attendeeId: fixture.attendeeId, references: fixture.references },
      ])
    )[0],
    `Missing refund plan for attendee ${fixture.attendeeId}`,
  );

const postThenPlan = async (
  fixture: Fixture,
  plan: ComputedRefund,
): Promise<ComputedRefund> => {
  await postTransferGroups([plan.groups.flat()]);
  return planFor(fixture);
};

const deriveFacts = once(async (): Promise<Facts> => {
  const teardown = await bootLedger();
  let facts: Facts = {
    expected: [],
    legs: [],
    originals: [],
    references: [],
    reversals: [],
  };
  for (const fixture of await fixtures()) {
    await postFixture(fixture);
    const first = await planFor(fixture);
    const firstLegs = await ledgerLegs(fixture.attendeeId);
    const states: (readonly [ComputedRefund, Transfer[], RoundName])[] = [
      [first, firstLegs, "first"],
    ];
    if (fixture.replay) {
      states.push([
        await postThenPlan(fixture, first),
        await ledgerLegs(fixture.attendeeId),
        "replay",
      ]);
    }
    /* The partition universe is every reference of every round the fixture
     * feeds the checker. The original legs are the fixture ledger's legs the
     * first plan reads: every posted refund leg must pair its inverse
     * verdict with one of these. */
    const expected: readonly ExpectedReference[] = fixture.references.flatMap(
      (reference) =>
        states.map(([, , round]) => ({ reference: reference.index, round })),
    );
    const rounds = states.map(([computed, legs, round]) =>
      planFacts(fixture, legs, computed, round),
    );
    facts = mergeFacts(facts, {
      expected,
      legs: rounds.flatMap((round) => round.legs),
      originals: firstLegs.map((leg) => leg.reference),
      references: rounds.flatMap((round) => round.references),
      reversals: rounds.flatMap((round) => round.reversals),
    });
  }
  await teardown();
  return facts;
});

const moduleFor = (facts: Facts): string =>
  tlaModule("RefundReversalData", [
    tlaRecords("ExpectedReferences", expectedReferenceFields, facts.expected),
    tlaRecords("LegFacts", legFields, facts.legs),
    tlaRecords("ReferenceFacts", referenceFields, facts.references),
    tlaRecords("ReversalFacts", reversalFields, facts.reversals),
    `GroupLabels == ${tlaSet(unique(facts.reversals.map((fact) => fact.group)))}`,
    `OriginalLegs == ${tlaSet(facts.originals)}`,
    `ReferenceOutcomes == ${tlaSet(ReferenceOutcomesSchema.options)}`,
    `RoundNames == ${tlaSet(RoundNamesSchema.options)}`,
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

/** A negative control over the clean facts: the first posted refund leg
 *  changed by `change`. The checker must reject the result. */
const legControl =
  (change: (leg: LegFact) => LegFact): ModelDataSource =>
  async () =>
    moduleFor(
      changedFacts(await deriveFacts(), "legs", (leg, index) =>
        index === 0 ? change(leg) : leg,
      ),
    );

/** The clean proof data. The check must pass. */
export const refundReversalModelData: ModelDataSource = async () =>
  moduleFor(await deriveFacts());

/** The negative control for an operator-money reversal: the first plan
 *  reverses a group that carries operator money. The checker must reject
 *  it. */
export const operatorMoneyReversalData: ModelDataSource = reversalControl(
  (reversal) => reversal.round === "first" && reversal.group === "operator",
);

/** The negative control for a leg that is not the exact inverse of its
 *  original: the first plan posts a leg that inverts nothing. The checker
 *  must reject it. */
export const nonInverseLegData: ModelDataSource = legControl((leg) => ({
  ...leg,
  exactInverse: false,
}));

/** The reference the unpaired-leg control names instead of a recorded
 *  original. No fixture leg carries it. */
const UNPAIRED_ORIGINAL = "no-recorded-original";

/** The negative control for a leg that pairs with no recorded original: the
 *  first plan posts an exact inverse of a leg the ledger does not hold. The
 *  checker must reject it. */
export const unpairedLegData: ModelDataSource = legControl((leg) => ({
  ...leg,
  original: UNPAIRED_ORIGINAL,
}));

/** The negative control for a double record: the replay plan reverses the
 *  group the first plan recorded, so the refund credits twice. The checker
 *  must reject it. */
export const doubleRecordData: ModelDataSource = reversalControl(
  (reversal) => reversal.round === "replay" && reversal.group === "safe",
);
