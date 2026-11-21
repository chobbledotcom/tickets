import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { modelNames } from "#scripts/verify-models/jobs.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import {
  DEFAULT_RUNNER,
  MODEL_RUNNERS,
  modelRuns,
  runnerFor,
} from "#scripts/verify-models/runners.ts";

describe("model runners", () => {
  test("names only registered models, so a rename cannot leave a stale entry", () => {
    const registered = modelNames(VERIFICATION_MODULES);

    expect(
      Object.keys(MODEL_RUNNERS).filter((name) => !registered.includes(name)),
    ).toEqual([]);
  });

  test("gives a model that is not named the default runner", () => {
    expect(runnerFor("AttendeeCapacity")).toBe(DEFAULT_RUNNER);
  });

  test("gives a named model its own runner", () => {
    expect(runnerFor("SubscriptionLifecycle")).toBe("ubicloud-standard-8");
  });

  test("pairs every registered model with its runner, in registry order", () => {
    expect(modelRuns(VERIFICATION_MODULES)).toEqual(
      modelNames(VERIFICATION_MODULES).map((model) => ({
        model,
        runner: runnerFor(model),
      })),
    );
  });
});
