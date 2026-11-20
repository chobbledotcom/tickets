import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  modalLifecycleFacts,
  modalLifecycleModelData,
} from "#scripts/verify-models/modal-lifecycle.ts";
import { modalTargets } from "#scripts/verify-models/modal-lifecycle-matrix.ts";
import { parsedModalFacts } from "#test-utils/modal-lifecycle.ts";

test("the checker matrix preserves every observed transition and event identity", async () => {
  const facts = modalLifecycleFacts();
  const targets = modalTargets(facts);
  expect(targets).toHaveLength(71);
  for (const row of targets) expect(row).toHaveLength(12);
  for (const edge of facts.edges) {
    expect(targets[edge.source]?.[edge.event]).toBe(edge.target);
  }
  // This checks serialization, not lifecycle safety. The expected edges are
  // the original production observations, including all unchanged outcomes.
  expect(parsedModalFacts(await modalLifecycleModelData())).toEqual(facts);
});

test("matrix extraction refuses absent, duplicate and invalid observations", () => {
  const facts = modalLifecycleFacts();
  const first = facts.edges[0];
  if (first === undefined) throw new Error("Missing representative modal edge");
  for (const field of ["snapshots", "events"] as const) {
    expect(() => modalTargets({ ...facts, [field]: [] })).toThrow(
      "Empty modal transition domain",
    );
    const invalid = { ...facts, [field]: [...facts[field]].reverse() };
    const kind = field === "snapshots" ? "state" : "event";
    expect(() => modalTargets(invalid)).toThrow(
      `Modal ${kind} ids are not dense and ordered`,
    );
  }
  expect(() => modalTargets({ ...facts, edges: facts.edges.slice(1) })).toThrow(
    "Missing modal transition 0/0",
  );
  expect(() =>
    modalTargets({ ...facts, edges: [...facts.edges, first] }),
  ).toThrow("Duplicate modal transition");
  const invalidEdges = [
    [{ ...first, source: -1 }, "source"],
    [{ ...first, event: 0.5 }, "event"],
    [{ ...first, target: facts.snapshots.length }, "target"],
  ] as const;
  for (const [edge, field] of invalidEdges) {
    expect(() =>
      modalTargets({ ...facts, edges: [edge, ...facts.edges.slice(1)] }),
    ).toThrow(`Invalid modal ${field} index`);
  }
});

test("checker data parsing validates actual record atoms and matrix dimensions", async () => {
  const data = await modalLifecycleModelData();
  const corruptions = [
    ["aPoint |-> -1", "aPoint |-> TRUE", /Expected number/],
    ["aPoint |-> -1", "aPoint |-> 0.5", /integer/i],
    ['key |-> "a"', "key |-> TRUE", /Expected string/],
    ["Targets ==", "Missing ==", /Missing checker Targets matrix/],
  ] as const;
  for (const [before, after, error] of corruptions) {
    expect(() => parsedModalFacts(data.replace(before, after))).toThrow(error);
  }
  const wideRow = data.replace(
    /Targets == <<\n<<([^>]*)>>/,
    "Targets == <<\n<<$1, 0>>",
  );
  expect(() => parsedModalFacts(wideRow)).toThrow(/length/i);
});
