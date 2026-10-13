import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runCompactDenoTest } from "#scripts/compact-test-reporter.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { capturingConsole } from "#test-utils/captured-console.ts";
import { tempFile } from "#test-utils/files.ts";
import { TEST_NAME_FILTER_ENV } from "#test-utils/test-name-filter.ts";

const FIXTURE_DIR = "test/scripts/test-name-filter/fixtures";

/** Runs one fixture the way the runners do — the standard preload, the TAP
 * reporter, and the compact runner's zero-match guard — and returns the
 * exit code. */
const runFixture = async (fixture: string, filter: string): Promise<number> => {
  const marks = tempFile();
  try {
    const { value } = await capturingConsole(() =>
      runCompactDenoTest(
        [
          "test",
          "--no-check",
          "--allow-all",
          "--preload",
          "./test/test-utils/preload.ts",
          "--reporter",
          "tap",
          `${FIXTURE_DIR}/${fixture}`,
        ],
        {
          cwd: projectRoot,
          env: {
            ...Deno.env.toObject(),
            [TEST_NAME_FILTER_ENV]: filter,
            TICKETS_TEST_FILTER_MARKS: marks.path,
          },
          nameFilter: filter,
        },
      )
    );
    return value;
  } finally {
    marks.dispose();
  }
};

describe("the zero-match guard on the compact runner", () => {
  test("fails a filtered run whose only match is an ignored leaf", async () => {
    expect(await runFixture("ignored-only.ts", "ignored leaf")).toBe(1);
  });

  test("fails a filtered run that selects only an all-ignored group", async () => {
    expect(await runFixture("ignored-only.ts", "all ignored group")).toBe(1);
  });

  test("passes a filtered run that executed a leaf", async () => {
    expect(await runFixture("nested.ts", "leaf alpha")).toBe(0);
  });
});
