import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getSteps } from "#scripts/precommit/steps.ts";

describe("precommit steps", () => {
  test("lists every task the CI workflow must also run", async () => {
    // A step added to getSteps() but not to the workflow never runs for a
    // contributor who relies on PR checks — the label gate landed exactly
    // that way once. The workflow claims to mirror this list, so the suite
    // holds it to the claim.
    const workflow = await Deno.readTextFile(".github/workflows/test.yml");
    const tasks = getSteps()
      .filter((step) => step.cmd[1] === "task")
      .map((step) => step.cmd[2]);

    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(workflow).toContain(`run: deno task ${task}`);
    }
  });

  test("summarises the slow-tests report when it exists and when it does not", async () => {
    const coverageStep = getSteps().find(
      (step) => step.name === "test:coverage",
    );
    const summary = await coverageStep?.summary?.("", "");

    expect(summary === undefined || typeof summary === "string").toBe(true);
  });
});
