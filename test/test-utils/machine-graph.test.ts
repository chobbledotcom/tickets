import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { machineGraph } from "#test-utils/machine-graph.ts";

/** A three-step toy machine: forward moves a→b→c, reset jumps c→a. */
const graph = machineGraph({
  events: [
    { actor: "system", id: "forward" },
    { actor: "owner", id: "reset" },
  ] as const,
  label: "toy",
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] as const,
  targets: (from, event) => {
    if (event === "forward" && from === "a") return ["b"];
    if (event === "forward" && from === "b") return ["c"];
    if (event === "reset" && from === "c") return ["a"];
    return [];
  },
});

describe("machine graph walks", () => {
  test("finds nodes and events by id", () => {
    expect(graph.nodeById("b")).toEqual({ id: "b" });
    expect(graph.eventById("reset")).toEqual({ actor: "owner", id: "reset" });
  });

  test("refuses an id the machine does not declare", () => {
    expect(() => graph.nodeById("z" as "a")).toThrow("Unknown toy node z");
    expect(() => graph.eventById("skip" as "reset")).toThrow(
      "Unknown toy event skip",
    );
  });

  test("lists one-step successors, honouring the event filter", () => {
    expect(graph.successors("b")).toEqual(["c"]);
    expect(graph.successors("c")).toEqual(["a"]);
    expect(graph.successors("c", (event) => event.actor === "system")).toEqual(
      [],
    );
  });

  test("collects everything reachable, honouring the event filter", () => {
    expect([...graph.reachableFrom("a")].sort()).toEqual(["a", "b", "c"]);
    expect([
      ...graph.reachableFrom("c", (event) => event.actor === "system"),
    ]).toEqual(["c"]);
  });
});
