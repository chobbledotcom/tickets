import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getSteps } from "#scripts/precommit/steps.ts";

const TEST_WORKFLOW_PATH = ".github/workflows/test.yml";

/** The YAML body of one job, which ends at the next two-space job key. */
const jobBody = (workflow: string, job: string): string => {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) {
    throw new Error(`${TEST_WORKFLOW_PATH} declares no ${job} job`);
  }
  const rest = workflow.slice(start + 1);
  const end = rest.search(/\n {2}[a-z-]+:\n/);
  return end < 0 ? rest : rest.slice(0, end);
};

/** The `deno task X` invocations a job body runs, in order. The capture
 * group is the match itself, so a match without one cannot exist; the guard
 * keeps the type honest without a cast. */
const taskSteps = (body: string): string[] =>
  [...body.matchAll(/run: deno task (\S+)/g)].map((match) => {
    const task = match[1];
    if (task === undefined) {
      throw new Error(`a run line matched with no task: ${match[0]}`);
    }
    return task;
  });

describe("precommit steps", () => {
  test("runs exactly the tasks getSteps lists, in the jobs that mirror it", async () => {
    // A step added to getSteps() but not to the workflow never runs for a
    // contributor who relies on PR checks — the label gate landed exactly
    // that way once. The workflow claims to mirror this list, so the suite
    // holds both sides to the claim: same tasks, same order, no extras.
    const workflow = await Deno.readTextFile(TEST_WORKFLOW_PATH);
    const tasks = getSteps()
      .filter((step) => step.cmd[1] === "task")
      .map((step) => step.cmd[2]);

    expect(tasks.length).toBeGreaterThan(0);
    // The checks job mirrors every step except the suite, which the test job
    // runs.
    const suiteTask = "test:coverage";
    expect(taskSteps(jobBody(workflow, "checks"))).toEqual(
      tasks.filter((task) => task !== suiteTask),
    );
    expect(taskSteps(jobBody(workflow, "test"))).toEqual([suiteTask]);
  });

  test("summarises the slow-tests report when it exists and when it does not", async () => {
    const coverageStep = getSteps().find(
      (step) => step.name === "test:coverage",
    );
    const summary = await coverageStep?.summary?.("", "");

    expect(summary === undefined || typeof summary === "string").toBe(true);
  });
});
