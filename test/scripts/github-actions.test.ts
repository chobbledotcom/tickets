/** Direct tests for the shared GitHub Actions result-file appends. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  appendStepSummary,
  publishExecutedResult,
} from "#scripts/github-actions.ts";
import { withEnv } from "#test-utils/env.ts";
import { tempDir, tempFile } from "#test-utils/files.ts";

describe("appendStepSummary", () => {
  test("appends the Markdown to the named file and reports the write", () => {
    using file = tempFile({ prefix: "gha-summary-" });
    using _env = withEnv({ GITHUB_STEP_SUMMARY: file.path });
    expect(appendStepSummary("## first\n")).toBe(true);
    expect(appendStepSummary("## second\n")).toBe(true);
    expect(Deno.readTextFileSync(file.path)).toBe("## first\n## second\n");
  });

  test("does nothing outside GitHub Actions", () => {
    using _env = withEnv({ GITHUB_STEP_SUMMARY: undefined });
    expect(appendStepSummary("## unseen\n")).toBe(false);
  });

  test("never throws when the named path cannot be written", () => {
    using dir = tempDir({ prefix: "gha-summary-dir-" });
    using _env = withEnv({ GITHUB_STEP_SUMMARY: dir.path });
    expect(appendStepSummary("## unwritable\n")).toBe(false);
  });
});

describe("publishExecutedResult", () => {
  test("appends the executed handshake to the job output file", () => {
    using file = tempFile({ prefix: "gha-output-" });
    using _env = withEnv({ GITHUB_OUTPUT: file.path });
    expect(publishExecutedResult()).toBe(true);
    expect(Deno.readTextFileSync(file.path)).toBe("result=executed\n");
  });

  test("does nothing outside GitHub Actions", () => {
    using _env = withEnv({ GITHUB_OUTPUT: undefined });
    expect(publishExecutedResult()).toBe(false);
  });
});
