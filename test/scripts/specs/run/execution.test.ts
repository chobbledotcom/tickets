import type { Envelope } from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { runSpecs } from "#scripts/specs/run.ts";
import type { SpecCatalog } from "#scripts/specs/types.ts";
import { CONCURRENT_ROWS } from "#test/scripts/specs/fixtures/concurrent.steps.ts";
import {
  requiredSpecRunsPath,
  SPEC_RUNS_PATH_ENV,
} from "#test/scripts/specs/fixtures/record-step.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  createOutlineFixture,
  type OutlineFixture,
  removeOutlineFixture,
} from "./outline-fixture.ts";

const readMessages = async (reportDir: string): Promise<Envelope[]> =>
  (await Deno.readTextFile(`${reportDir}/cucumber.ndjson`))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const WORKING_STEPS = "test/scripts/specs/fixtures/selected.steps.ts";

/** Run the throwaway Feature, with whatever is passed layered on top. */
const runOutline = async (
  fixture: OutlineFixture,
  options: Parameters<typeof runSpecs>[0],
  support: string[] = [WORKING_STEPS],
): Promise<{ success: boolean }> =>
  await runSpecs(
    { paths: [fixture.featurePath], ...options },
    { reportDir: fixture.environment.reportDir, support },
    { env: { [SPEC_RUNS_PATH_ENV]: fixture.runsPath }, parallel: 0 },
  );

const withOutline = async (
  body: (fixture: OutlineFixture) => Promise<void>,
): Promise<void> => {
  const fixture = await createOutlineFixture(WORKING_STEPS);
  try {
    await body(fixture);
  } finally {
    await removeOutlineFixture(fixture);
  }
};

/** Everything the run complained about while it ran. */
const complaintsFrom = async (
  run: () => Promise<unknown>,
): Promise<string[]> => {
  const complaints: string[] = [];
  using _error = stub(console, "error", (...parts: unknown[]) => {
    complaints.push(parts.map(String).join(" "));
  });
  await run();
  return complaints;
};

describe("Cucumber execution", () => {
  test("requires the path used to record selected examples", () => {
    using _env = withEnv({ [SPEC_RUNS_PATH_ENV]: undefined });
    expect(() => requiredSpecRunsPath()).toThrow(
      `${SPEC_RUNS_PATH_ENV} is required`,
    );
  });

  test("removes stale reports before catalog validation", async () => {
    const reportDir = await Deno.makeTempDir();
    const staleReports = [
      "cucumber.html",
      "cucumber.junit.xml",
      "cucumber.ndjson",
    ];
    try {
      await Promise.all(
        staleReports.map((name) =>
          Deno.writeTextFile(`${reportDir}/${name}`, "stale success"),
        ),
      );
      await expect(
        runSpecs({ paths: ["specs/owners.json"] }, { reportDir, support: [] }),
      ).rejects.toThrow("No Cucumber Feature files found");
      await expect(Array.fromAsync(Deno.readDir(reportDir))).resolves.toEqual(
        [],
      );
    } finally {
      await Deno.remove(reportDir, { recursive: true });
    }
  });

  test("surfaces a report cleanup failure", async () => {
    const directory = await Deno.makeTempDir();
    const file = `${directory}/file`;
    await Deno.writeTextFile(file, "not a directory");
    try {
      await expect(
        runSpecs({}, { reportDir: `${file}/reports`, support: [] }),
      ).rejects.toThrow();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  test("runs one selected Outline row through lifecycle controls", async () => {
    const fixture = await createOutlineFixture(
      "test/scripts/specs/fixtures/selected.steps.ts",
    );
    const lifecycle: string[] = [];
    try {
      expect(
        await runSpecs(
          {
            paths: [fixture.featurePath],
            tags: "@case:payment.selection-second",
          },
          {
            reportDir: fixture.environment.reportDir,
            support: fixture.environment.support,
          },
          {
            beforeRun: (catalog) => {
              lifecycle.push(
                `before:${catalog.stories[0]?.rules[0]?.cases.length}`,
              );
            },
            env: { [SPEC_RUNS_PATH_ENV]: fixture.runsPath },
            onSuccess: (messages) => {
              lifecycle.push(`success:${messages.length > 0}`);
            },
            parallel: 0,
          },
        ),
      ).toEqual({ success: true });
      expect(lifecycle).toEqual(["before:2", "success:true"]);

      const messages = await readMessages(fixture.environment.reportDir);
      const testCases = messages.flatMap(({ testCase }) =>
        testCase ? [testCase] : [],
      );
      expect(testCases).toHaveLength(1);
      const selectedPickles = testCases.flatMap((testCase) =>
        messages.flatMap(({ pickle }) =>
          pickle && pickle.id === testCase.pickleId ? [pickle] : [],
        ),
      );
      expect(selectedPickles).toEqual([
        expect.objectContaining({ name: "Payment result second" }),
      ]);
    } finally {
      await removeOutlineFixture(fixture);
    }
  });

  test("runs Outline rows concurrently in separate workers", async () => {
    using _jobs = withEnv({ DENO_JOBS: "2" });
    // Each row's step waits for the other row to start, so the run can only
    // succeed when both rows really are in flight together. Rows taken one
    // after another leave the first waiting and the run fails.
    const fixture = await createOutlineFixture(
      "test/scripts/specs/fixtures/concurrent-support.ts",
    );
    try {
      expect(
        await runSpecs({ paths: [fixture.featurePath] }, fixture.environment),
      ).toEqual({ success: true });
      expect((await Deno.readTextFile(fixture.runsPath)).split("\n")).toEqual([
        "run",
        "run",
        "",
      ]);
      const messages = await readMessages(fixture.environment.reportDir);
      const starts = messages.flatMap(({ testCaseStarted }) =>
        testCaseStarted ? [testCaseStarted] : [],
      );
      const finishes = messages.flatMap(({ testCaseFinished }) =>
        testCaseFinished ? [testCaseFinished] : [],
      );
      expect(starts).toHaveLength(CONCURRENT_ROWS);
      expect(finishes).toHaveLength(CONCURRENT_ROWS);
      expect(new Set(starts.map(({ workerId }) => workerId)).size).toBe(
        CONCURRENT_ROWS,
      );
    } finally {
      await removeOutlineFixture(fixture);
    }
  });

  test("fails when a stable case filter matches no catalog case", async () => {
    const directory = await Deno.makeTempDir();
    try {
      expect(
        await runSpecs(
          { reports: false, tags: "@case:not.in-catalog" },
          { reportDir: `${directory}/reports`, support: [] },
        ),
      ).toEqual({ success: false });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  test("selects nothing at all when the asked-for case is not in the catalog", async () => {
    await withOutline(async (fixture) => {
      // The Feature would pass if it ran, so only a filter that keeps every
      // case out can make this fail.
      expect(
        await runOutline(fixture, { tags: "@case:not.in-catalog" }),
      ).toEqual({ success: false });

      // Nothing was tried at all, rather than tried and failed.
      const messages = await readMessages(fixture.environment.reportDir);
      expect(messages.filter(({ testCase }) => testCase)).toEqual([]);
    });
  });

  test("fails a run whose steps nobody has written", async () => {
    await withOutline(async (fixture) => {
      expect(
        await runOutline(
          fixture,
          { reports: false, tags: "@case:payment.selection-first" },
          [],
        ),
      ).toEqual({ success: false });
    });
  });

  test("runs a failing case once instead of trying it again", async () => {
    await withOutline(async (fixture) => {
      const complaints = await complaintsFrom(() =>
        runOutline(fixture, { tags: "@case:payment.selection-first" }, [
          "test/scripts/specs/fixtures/failing.steps.ts",
        ]),
      );

      // A second attempt would be reported as a retry, which we never allow.
      expect(complaints).toEqual([]);
      const messages = await readMessages(fixture.environment.reportDir);
      expect(
        messages.filter(({ testCaseStarted }) => testCaseStarted),
      ).toHaveLength(1);
    });
  });

  test("makes the whole reports folder, however deep it is", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const reportDir = `${directory}/nested/deeper/reports`;

      await expect(
        runSpecs({ paths: ["specs/owners.json"] }, { reportDir, support: [] }),
      ).rejects.toThrow("No Cucumber Feature files found");

      expect((await Deno.stat(reportDir)).isDirectory).toBe(true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  test("reads the specs folder when asked for no paths in particular", async () => {
    const directory = await Deno.makeTempDir();
    let catalogued: SpecCatalog | undefined;
    try {
      await expect(
        runSpecs(
          { reports: false },
          { reportDir: `${directory}/reports`, support: [] },
          {
            beforeRun: (catalog) => {
              catalogued = catalog;
              // Stop before Cucumber runs: the catalog is all this checks.
              throw new Error("read the catalog");
            },
          },
        ),
      ).rejects.toThrow("read the catalog");

      expect(catalogued?.stories.length).toBeGreaterThan(0);
      // Everything it found came from the specs folder, not from wherever the
      // command happened to be run.
      expect(
        catalogued?.stories.every((story) => story.uri.startsWith("specs/")),
      ).toBe(true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
