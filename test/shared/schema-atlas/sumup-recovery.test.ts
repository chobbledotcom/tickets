/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  RECOVERY_NODES,
  type RecoveryNodeId,
} from "#payment/sumup-recovery-machine-spec.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import { sumupRecoveryAtlas } from "#shared/schema-atlas/sumup-recovery.ts";

/* jscpd:ignore-end */

const atlas = sumupRecoveryAtlas();
const stateById = (id: RecoveryNodeId) => {
  const state = atlas.states.find((one) => one.id === id);
  if (!state) throw new Error(`The map has no ${id} state`);
  return state;
};

describe("sumup recovery atlas", () => {
  test("declares its identity, keys, and every node's place on the map", () => {
    expect(atlas.id).toBe("sumup_recovery");
    expect(atlas.titleKey).toBe("schema.sumup_recovery.title");
    expect(atlas.introKey).toBe("schema.sumup_recovery.intro");
    expect(
      atlas.states.map(({ id, labelKey, layout }) => ({
        id,
        labelKey,
        layout,
      })),
    ).toEqual([
      {
        id: "staged",
        labelKey: "schema.sumup_recovery.state.staged",
        layout: { x: 140, y: 240 },
      },
      {
        id: "waiting",
        labelKey: "schema.sumup_recovery.state.waiting",
        layout: { x: 480, y: 240 },
      },
      {
        id: "unpaid",
        labelKey: "schema.sumup_recovery.state.unpaid",
        layout: { x: 820, y: 240 },
      },
      {
        id: "finished",
        labelKey: "schema.sumup_recovery.state.finished",
        layout: { x: 820, y: 80 },
      },
      {
        id: "owed",
        labelKey: "schema.sumup_recovery.state.owed",
        layout: { x: 820, y: 400 },
      },
    ]);
  });

  test("draws every node the machine declares, and no others", () => {
    expect(atlas.states.map((state) => state.id).sort()).toEqual(
      RECOVERY_NODES.map((node) => node.id).sort(),
    );
  });

  test("starts at the row a staging write makes", () => {
    expect(
      atlas.states.filter((state) => state.start === true).map((s) => s.id),
    ).toEqual(["staged"]);
  });

  test("tells the operator whether a state may be holding money", () => {
    // The two facts an operator acts on, read off the declaration rather than
    // written out again beside it.
    expect(stateById("owed").facts).toEqual([
      { labelKey: "schema.sumup_recovery.fact.owes_money", value: "yes" },
      {
        labelKey: "schema.sumup_recovery.fact.kept",
        value: "kept until answered",
      },
    ]);
    expect(stateById("finished").facts).toEqual([
      { labelKey: "schema.sumup_recovery.fact.owes_money", value: "no" },
      {
        labelKey: "schema.sumup_recovery.fact.kept",
        value: "deleted once old",
      },
    ]);
  });

  test("says a live checkout's money is unknown, not absent", () => {
    // "no" here would be the lie the whole feature exists to stop telling.
    expect(stateById("waiting").facts[0]?.value).toBe("unknown");
  });

  test("draws an edge out of every state a check can move", () => {
    for (const id of ["staged", "waiting", "owed"] as const) {
      expect(stateById(id).edges.length, id).toBeGreaterThan(0);
    }
  });

  test("draws no way out of a closed state", () => {
    expect(stateById("unpaid").edges).toEqual([]);
    expect(stateById("finished").edges).toEqual([]);
  });

  test("joins the machines the schema page folds over", () => {
    expect(SCHEMA_ATLAS_MACHINES.map((machine) => machine.id)).toContain(
      "sumup_recovery",
    );
  });
});
