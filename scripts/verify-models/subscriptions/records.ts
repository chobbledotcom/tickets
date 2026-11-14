/** Subscription record facts execute production writes on isolated schema copies.
 * Expected plans come from synthetic inputs, never from a production verdict.
 * SQL transaction atomicity and the supplied local database remain assumptions;
 * the producer also executes one writer-time overlap and one late rollback.
 */
import { generateKeyPair } from "#crypto/hybrid.ts";
import { tlaModule } from "#scripts/verify-models/data.ts";
import { type Faults, producerFor, recordSetsFor } from "./controls.ts";
import { withSubscriptionDb } from "./environment.ts";
import { RECORD_TABLES, type RecordFacts } from "./records-facts.ts";
import { recordScenarios, runRecordScenario } from "./records-operations.ts";
import { projectionFacts } from "./records-projection.ts";

export const collectRecordFacts = async (): Promise<RecordFacts> => {
  const keys = await generateKeyPair();
  const operations: RecordFacts["operations"] = [];
  // The global application database is replaced only within each fixture scope.
  // Parallel calls would observe a different fixture, so run these in sequence.
  for (const scenario of recordScenarios())
    operations.push(await runRecordScenario(scenario, undefined, keys));
  return { operations, ...(await withSubscriptionDb(() => projectionFacts())) };
};

const recordSets = recordSetsFor(RECORD_TABLES);

/** Each control changes one independent business outcome. Corrupt domains are
 * checked at Init; unsafe observed outcomes are replayed by unrestricted Next.
 */
/* jscpd:ignore-start -- a list of strings, not code */
const movedPlan = { scenario: "merge-move:active:0" };
const refusedDelete = { scenario: "delete:active:0" };
const FAULTS: Faults = {
  fields: [
    [
      "lost-live-plan-remove",
      "operations",
      "present",
      "",
      { scenario: "edit-drop:active:0" },
    ],
    ["lost-live-plan-delete", "operations", "present", "", refusedDelete],
    [
      "lost-live-plan-merge",
      "operations",
      "present",
      "",
      { scenario: "merge-drop-source:active:1" },
    ],
    [
      "wrong-preserved-plan-identity",
      "operations",
      "subscription",
      "sub_wrong",
      movedPlan,
    ],
    ["wrong-preserved-plan-amount", "operations", "price", "", movedPlan],
    ["wrong-preserved-plan-tax", "operations", "tax", "", movedPlan],
    [
      "wrong-preserved-plan-interval",
      "operations",
      "interval",
      "year",
      movedPlan,
    ],
    [
      "wrong-preserved-plan-status",
      "operations",
      "afterStatus",
      "canceled",
      movedPlan,
    ],
    ["partial-refusal", "operations", "recordsUnchanged", "", refusedDelete],
    [
      "partial-refusal-money",
      "operations",
      "moneyUnchanged",
      "",
      refusedDelete,
    ],
    [
      "misattributed-projected-booking",
      "observed",
      "attendee",
      "",
      { booking: "1" },
    ],
  ],
  missing: [
    [
      "omitted-quantity-zero-booking",
      "step",
      "observed",
      { booking: "1", quantity: "0" },
    ],
    [
      "missing-required-record-domain",
      "initial",
      "operations",
      { status: "paused" },
    ],
  ],
};
/* jscpd:ignore-end */

export const { controls, modelData } = producerFor(
  collectRecordFacts,
  (facts) => tlaModule("SubscriptionRecordsData", recordSets(facts)),
  (facts) => facts,
  FAULTS,
  (changedData) => [
    {
      data: changedData((facts) => {
        const row = facts.observed.find((row) => row.booking === 1);
        if (!row) throw new Error("Missing duplicate booking control");
        facts.observed.push({ ...row, slot: 999 });
      }),
      name: "duplicate-projected-booking",
      phase: "step",
    },
  ],
);
