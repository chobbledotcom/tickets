import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AtlasTrigger,
  atlasState,
  attemptTransition,
  dedupeEdges,
  edgesFromTriggers,
} from "#shared/schema-atlas/types.ts";

describe("atlas derivation helpers", () => {
  test("a transition that throws is not an option; one that returns is", () => {
    expect(attemptTransition(() => "next", "from")).toBe("next");
    expect(
      attemptTransition(() => {
        throw new Error("refused");
      }, "from"),
    ).toBe(null);
  });

  test("duplicate edges collapse to one per label and target", () => {
    const edges = dedupeEdges([
      { actor: "system", labelKey: "a", to: "x" },
      { actor: "provider", labelKey: "a", to: "x" },
      { actor: "system", labelKey: "a", to: "y" },
      { actor: "system", labelKey: "b", to: "x" },
    ]);
    expect(edges).toEqual([
      { actor: "system", labelKey: "a", to: "x" },
      { actor: "system", labelKey: "a", to: "y" },
      { actor: "system", labelKey: "b", to: "x" },
    ]);
  });

  test("triggered edges exist only where the transition succeeds", () => {
    const triggers: readonly AtlasTrigger<string>[] = [
      {
        actor: "owner",
        labelKey: "go",
        run: (state) => {
          if (state !== "start") {
            throw new Error("only from the start");
          }
          return "done";
        },
      },
      {
        actor: "system",
        labelKey: "stay",
        run: () => {
          throw new Error("never an option");
        },
      },
    ];
    const nodeIdOf = (state: string): string => state;
    expect(edgesFromTriggers(triggers, nodeIdOf, ["start"])).toEqual([
      { actor: "owner", labelKey: "go", to: "done" },
    ]);
    expect(edgesFromTriggers(triggers, nodeIdOf, ["done"])).toEqual([]);
  });

  test("a declared node derives its keys from the machine's own prefix", () => {
    const plain = atlasState("schema.review.state", "open", { x: 1, y: 2 }, []);
    expect(plain).toEqual({
      detailKey: "schema.review.state.open.detail",
      edges: [],
      facts: [],
      id: "open",
      labelKey: "schema.review.state.open",
      layout: { x: 1, y: 2 },
    });
    expect(plain.start).toBeUndefined();
    expect(
      atlasState("schema.review.state", "none", { x: 0, y: 0 }, [], {
        facts: [{ labelKey: "schema.fact.cleared_by", value: "x" }],
        start: true,
      }),
    ).toMatchObject({
      facts: [{ labelKey: "schema.fact.cleared_by", value: "x" }],
      start: true,
    });
  });
});
