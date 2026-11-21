import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  duplicateRankModalData,
  forgottenPositionModalData,
  type ModalFacts,
  type ModalSnapshot,
  modalLifecycleModelData,
  reversedSurvivorsModalData,
  stuckWindowFocusModalData,
  twoBrightWindowsModalData,
} from "#scripts/verify-models/modal-lifecycle.ts";
import {
  edgeIdsFor,
  forgottenSaveEdge,
  type ModalWitness,
  parsedModalFacts,
  reversedSurvivorsEdge,
  snapshotFixture,
  snapshotFromEdge,
  snapshotId,
  stuckFocusEdge,
  witnessFacts,
} from "#test-utils/modal-lifecycle.ts";

/** A control that replaces one domain row. `real` is the row that the
 * control finds, and `corrupted` is the row that it leaves. */
const rowControl = (
  name: string,
  source: typeof modalLifecycleModelData,
  real: ModalSnapshot,
  corrupted: ModalSnapshot,
) =>
  [
    name,
    source,
    "snapshots",
    (facts: ModalFacts) => ({ ...corrupted, id: snapshotId(facts, real) }),
    null,
  ] as const;

/** A control that replaces the target of one edge with a declared state. */
const edgeControl = (
  name: string,
  source: typeof modalLifecycleModelData,
  edge: ModalWitness,
) =>
  [
    name,
    source,
    "edges",
    (facts: ModalFacts) => edgeIdsFor(facts, edge),
    snapshotFromEdge(edge, "after"),
  ] as const;

const twoWindows = snapshotFixture({
  aPoint: 0,
  aRank: 1,
  bPoint: 0,
  bRank: 2,
});

const controls = [
  // The corrupted row keeps the dim of the real two-window stack.
  rowControl(
    "the initial control changes exactly one domain row and no transition",
    duplicateRankModalData,
    twoWindows,
    { ...twoWindows, bRank: 1 },
  ),
  rowControl(
    "the bright control changes exactly one dim flag and no transition",
    twoBrightWindowsModalData,
    twoWindows,
    { ...twoWindows, aDim: 0 },
  ),
  edgeControl(
    "the step control changes exactly one saved point and no domain row",
    forgottenPositionModalData,
    forgottenSaveEdge,
  ),
  edgeControl(
    "the focus control keeps one press on the page in the window's focus and reaches a valid declared state",
    stuckWindowFocusModalData,
    stuckFocusEdge,
  ),
  edgeControl(
    "the close control reverses exactly two survivors but still reaches a valid declared state",
    reversedSurvivorsModalData,
    reversedSurvivorsEdge,
  ),
];

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
