import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const TEST_WORKFLOW_PATH = ".github/workflows/test.yml";

const readWorkflow = (): Promise<string> =>
  Deno.readTextFile(TEST_WORKFLOW_PATH);

/** The `on:` block, which ends at the next top-level key. */
const triggers = (workflow: string): string => {
  const start = workflow.indexOf("\non:\n");
  if (start < 0) throw new Error(`${TEST_WORKFLOW_PATH} declares no triggers`);
  const body = workflow.slice(start + 1);
  const end = body.search(/\n[a-z]/);
  return end < 0 ? body : body.slice(0, end);
};

describe("Test workflow triggers", () => {
  test("does not run the suite twice on a merge queue branch", async () => {
    // A queue branch arrives as a push, so without this the suite runs once
    // for `push` and again for `merge_group`. The queue waits for both, and a
    // stalled duplicate once timed the queue out an hour after the real run
    // had passed.
    expect(triggers(await readWorkflow())).toContain(
      'branches-ignore: [main, "gh-readonly-queue/**"]',
    );
  });

  test("still reports on a merge queue branch, which the queue gates on", async () => {
    // The pair matters: ignoring queue branches without this leaves the queue
    // waiting for checks that never arrive, which is worse than the duplicate.
    expect(triggers(await readWorkflow())).toContain("merge_group:");
  });

  test("still runs on every branch a person pushes", async () => {
    expect(triggers(await readWorkflow())).toContain("push:");
  });
});
