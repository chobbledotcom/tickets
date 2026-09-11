import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PRECOMMIT_STATUS_DIR,
  PrecommitStatusFilenameSchema,
  PrecommitStatusSchema,
} from "#scripts/precommit/status-schema.ts";
import { getSteps, PRECOMMIT_STEP_NAMES } from "#scripts/precommit/steps.ts";

const timestamp = "2026-09-10T10:00:00.000Z";
const waiting = {
  createdAt: timestamp,
  exitCode: null,
  pid: 123,
  state: "waiting",
  step: null,
  stepCompletedAt: null,
  updatedAt: timestamp,
};

describe("precommit status schema", () => {
  test("names the shared relative record directory", () => {
    expect(PRECOMMIT_STATUS_DIR).toBe(".diagnostics/precommit");
  });

  test("accepts only UUID JSON filenames", () => {
    expect(
      v.is(PrecommitStatusFilenameSchema, `${crypto.randomUUID()}.json`),
    ).toBe(true);
    for (const filename of ["../run.json", "run.json", ".tmp", "secret.json"]) {
      expect(v.is(PrecommitStatusFilenameSchema, filename)).toBe(false);
    }
  });

  test("derives safe step labels from the actual checks", () => {
    expect(PRECOMMIT_STEP_NAMES).toEqual(getSteps().map((step) => step.name));
    for (const step of PRECOMMIT_STEP_NAMES) {
      expect(
        v.is(PrecommitStatusSchema, { ...waiting, state: "running", step }),
      ).toBe(true);
    }
  });

  test("accepts queued, completed-step, and terminal records", () => {
    for (const changes of [
      {},
      { state: "running", step: "lint", stepCompletedAt: timestamp },
      { exitCode: 0, state: "passed" },
      { exitCode: 1, state: "failed" },
      { exitCode: -1, state: "failed" },
      { exitCode: Number.MAX_SAFE_INTEGER + 1, state: "failed" },
      { exitCode: 2, state: "failed", step: "lint" },
    ]) {
      expect(v.is(PrecommitStatusSchema, { ...waiting, ...changes })).toBe(
        true,
      );
    }
  });

  test("rejects invalid state facts and extra private fields", () => {
    for (const changes of [
      { pid: 0 },
      { pid: 1.5 },
      { pid: Number.MAX_SAFE_INTEGER + 1 },
      { createdAt: "not a date" },
      { updatedAt: "2026-02-30T10:00:00.000Z" },
      { state: "unknown" },
      { step: "lint" },
      { stepCompletedAt: timestamp },
      { exitCode: 0 },
      { state: "running" },
      { state: "running", step: "secret command" },
      { exitCode: 1, state: "running", step: "lint" },
      { state: "passed" },
      { exitCode: 1, state: "passed" },
      { exitCode: 0, state: "failed" },
      { exitCode: -0, state: "failed" },
      { exitCode: 1.5, state: "failed" },
      { exitCode: 1, state: "failed", stepCompletedAt: timestamp },
      { command: "private command" },
    ]) {
      expect(v.is(PrecommitStatusSchema, { ...waiting, ...changes })).toBe(
        false,
      );
    }
  });
});
