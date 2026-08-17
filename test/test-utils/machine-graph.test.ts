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
  test("finds a node by id", () => {
    expect(graph.nodeById("b")).toEqual({ id: "b" });
  });

  test("finds an event by id", () => {
    expect(graph.eventById("reset")).toEqual({ actor: "owner", id: "reset" });
  });

  test("refuses a node id the machine does not declare", () => {
    expect(() => graph.nodeById("z" as "a")).toThrow("Unknown toy node z");
  });

  test("refuses an event id the machine does not declare", () => {
    expect(() => graph.eventById("skip" as "reset")).toThrow(
      "Unknown toy event skip",
    );
  });

  test("lists one-step successors", () => {
    expect(graph.successors("b")).toEqual(["c"]);
    expect(graph.successors("c")).toEqual(["a"]);
  });

  test("drops moves whose event the filter rejects", () => {
    expect(graph.successors("c", (event) => event.actor === "system")).toEqual(
      [],
    );
  });

  test("collects everything reachable", () => {
    expect([...graph.reachableFrom("a")].sort()).toEqual(["a", "b", "c"]);
  });

  test("walks only the moves the filter keeps", () => {
    expect([
      ...graph.reachableFrom("c", (event) => event.actor === "system"),
    ]).toEqual(["c"]);
  });
});
