import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  captureScenarioEvidence,
  EVIDENCE_HOOK_TIMEOUT_MS,
} from "#scripts/specs/evidence/hook.ts";

const world = {
  attach: () => Promise.resolve(),
  evidenceValues: new Map<string, string>(),
};

const hook = {
  gherkinDocument: { comments: [] },
  pickle: {
    astNodeIds: [],
    id: "pickle",
    language: "en",
    name: "Scenario",
    steps: [],
    tags: [],
    uri: "specs/example.feature",
  },
};

describe("Cucumber evidence hook", () => {
  test("allows the browser capture two minutes to finish", () => {
    expect(EVIDENCE_HOOK_TIMEOUT_MS).toBe(120_000);
  });

  test("does not load browser capture outside evidence mode", async () => {
    let loads = 0;
    await captureScenarioEvidence(world, hook, undefined, async () => {
      loads++;
      return () => Promise.resolve();
    });

    expect(loads).toBe(0);
  });

  test("loads and runs capture in evidence mode", async () => {
    const calls: unknown[] = [];
    await captureScenarioEvidence(world, hook, "1", () =>
      Promise.resolve((receivedWorld, receivedHook) => {
        calls.push(receivedWorld, receivedHook);
        return Promise.resolve();
      }),
    );

    expect(calls).toEqual([world, hook]);
  });
});
