import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  duplicateRankModalData,
  forgottenPositionModalData,
  type ModalFacts,
  modalLifecycleModelData,
  reversedSurvivorsModalData,
} from "#scripts/verify-models/modal-lifecycle.ts";
import {
  edgeIdsFor,
  forgottenSaveEdge,
  parsedModalFacts,
  reversedSurvivorsEdge,
  snapshotFixture,
  snapshotFromEdge,
  snapshotId,
  witnessFacts,
} from "#test-utils/modal-lifecycle.ts";

const controls = [
  [
    "the initial control changes exactly one domain row and no transition",
    duplicateRankModalData,
    "snapshots",
    (facts: ModalFacts) => ({
      ...snapshotFixture({ aPoint: 0, aRank: 1, bPoint: 0, bRank: 1 }),
      id: snapshotId(
        facts,
        snapshotFixture({ aPoint: 0, aRank: 1, bPoint: 0, bRank: 2 }),
      ),
    }),
    null,
  ],
  [
    "the step control changes exactly one saved point and no domain row",
    forgottenPositionModalData,
    "edges",
    (facts: ModalFacts) => edgeIdsFor(facts, forgottenSaveEdge),
    snapshotFromEdge(forgottenSaveEdge, "after"),
  ],
  [
    "the close control reverses exactly two survivors but still reaches a valid declared state",
    reversedSurvivorsModalData,
    "edges",
    (facts: ModalFacts) => edgeIdsFor(facts, reversedSurvivorsEdge),
    snapshotFromEdge(reversedSurvivorsEdge, "after"),
  ],
] as const;

for (const [
  name,
  source,
  changedCollection,
  expected,
  validTarget,
] of controls) {
  test(name, async () => {
    const clean = await modalLifecycleModelData();
    const corrupted = await source();
    const cleanFacts = parsedModalFacts(clean);
    const corruptedFacts = parsedModalFacts(corrupted);
    expect(corruptedFacts.events).toEqual(cleanFacts.events);
    const unchanged = changedCollection === "edges" ? "snapshots" : "edges";
    expect(corruptedFacts[unchanged]).toEqual(cleanFacts[unchanged]);
    const good = cleanFacts[changedCollection];
    const bad = corruptedFacts[changedCollection];
    expect(
      bad.filter(
        (row, index) => JSON.stringify(row) !== JSON.stringify(good[index]),
      ),
    ).toEqual([expected(cleanFacts)]);
    if (validTarget !== null) {
      expect(witnessFacts(cleanFacts).snapshots).toContainEqual(validTarget);
    }
  });
}
