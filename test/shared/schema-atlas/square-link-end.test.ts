/** The Square link-end machine on the schema page: pin its layout and the
 * one fact an operator acts on, whether the link can still take payment. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LINK_END_NODES,
  type SquareLinkEndNodeId,
} from "#payment/square-link-end-machine-spec.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import { squareLinkEndAtlas as atlas } from "#shared/schema-atlas/square-link-end.ts";

/* jscpd:ignore-end */

const stateById = (id: SquareLinkEndNodeId) => {
  const state = atlas.states.find((one) => one.id === id);
  if (!state) throw new Error(`The map has no ${id} state`);
  return state;
};

describe("square link ends atlas", () => {
  test("declares its identity and every node's place on the map", () => {
    expect(atlas.id).toBe("square_link_ends");
    expect(atlas.titleKey).toBe("schema.square_link_ends.title");
    expect(atlas.introKey).toBe("schema.square_link_ends.intro");
    expect(
      atlas.states.map(({ id, labelKey, layout }) => ({
        id,
        labelKey,
        layout,
      })),
    ).toEqual([
      {
        id: "unwritten",
        labelKey: "schema.square_link_ends.state.unwritten",
        layout: { x: 140, y: 240 },
      },
      {
        id: "pending",
        labelKey: "schema.square_link_ends.state.pending",
        layout: { x: 380, y: 240 },
      },
      {
        id: "ending",
        labelKey: "schema.square_link_ends.state.ending",
        layout: { x: 620, y: 240 },
      },
      {
        id: "gone",
        labelKey: "schema.square_link_ends.state.gone",
        layout: { x: 900, y: 240 },
      },
    ]);
  });

  test("draws every node the machine declares, and no others", () => {
    expect(atlas.states.map((state) => state.id).sort()).toEqual(
      LINK_END_NODES.map((node) => node.id).sort(),
    );
  });

  test("starts at the row before Square made the link", () => {
    expect(
      atlas.states.filter((state) => state.start === true).map((s) => s.id),
    ).toEqual(["unwritten"]);
  });

  test("tells the operator whether the link can still take payment", () => {
    expect(stateById("pending").facts).toEqual([
      {
        labelKey: "schema.square_link_ends.fact.takes_payment",
        value: "yes",
      },
    ]);
    expect(stateById("ending").facts).toEqual([
      {
        labelKey: "schema.square_link_ends.fact.takes_payment",
        value: "until_square_answers",
      },
    ]);
    expect(stateById("gone").facts).toEqual([
      { labelKey: "schema.square_link_ends.fact.takes_payment", value: "no" },
    ]);
  });

  test("draws an edge out of every state the run can move", () => {
    for (const id of ["unwritten", "pending", "ending"] as const) {
      expect(stateById(id).edges.length, id).toBeGreaterThan(0);
    }
  });

  test("draws no way out of a closed state", () => {
    expect(stateById("gone").edges).toEqual([]);
  });

  test("joins the machines the schema page folds over", () => {
    expect(SCHEMA_ATLAS_MACHINES.map((machine) => machine.id)).toContain(
      "square_link_ends",
    );
  });
});
