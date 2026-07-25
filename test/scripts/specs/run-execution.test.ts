import type { Envelope } from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runSpecs, type SpecRunEnvironment } from "#scripts/specs/run.ts";
import {
  requiredSpecRunsPath,
  SPEC_RUNS_PATH_ENV,
} from "#test/scripts/specs/fixtures/record-step.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";

interface OutlineFixture {
  directory: string;
  env: EnvScope;
  environment: SpecRunEnvironment;
  featurePath: string;
  runsPath: string;
}

const createOutlineFixture = async (
  support: string,
): Promise<OutlineFixture> => {
  const directory = await Deno.makeTempDir();
  const featurePath = `${directory}/outline.feature`;
  const runsPath = `${directory}/runs.txt`;
  const env = withEnv({ [SPEC_RUNS_PATH_ENV]: runsPath });
  await Deno.writeTextFile(
    featurePath,
    `
@story:payments.outline-selection
@owner:payments @risk:high
@actor:customer @edition:managed
Feature: Select a payment example
  A stable case id selects one example from a Scenario Outline.

  @rule:payments.outline-selection-rule
  Rule: One example is selected
    Only the requested example is run.

    Scenario Outline: Payment result <label>
      Given a selected example runs

      Examples:
        | case_id                  | label  |
        | payment.selection-first  | first  |
        | payment.selection-second | second |
`,
  );
  return {
    directory,
    env,
    environment: { reportDir: `${directory}/reports`, support: [support] },
    featurePath,
    runsPath,
  };
};

const removeOutlineFixture = async (fixture: OutlineFixture): Promise<void> => {
  fixture.env.dispose();
  await Deno.remove(fixture.directory, { recursive: true });
};

const readMessages = async (reportDir: string): Promise<Envelope[]> =>
  (await Deno.readTextFile(`${reportDir}/cucumber.ndjson`))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

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

  test("runs exactly one Outline row selected by its stable case id", async () => {
    const fixture = await createOutlineFixture(
      "test/scripts/specs/fixtures/selected.steps.ts",
    );
    try {
      expect(
        await runSpecs(
          {
            paths: [fixture.featurePath],
            tags: "@case:payment.selection-second",
          },
          fixture.environment,
        ),
      ).toEqual({ success: true });

      const messages = await readMessages(fixture.environment.reportDir);
      const testCases = messages.flatMap(({ testCase }) =>
        testCase ? [testCase] : [],
      );
      expect(testCases).toHaveLength(1);
      const selectedPickle = messages.find(
        ({ pickle }) => pickle?.id === testCases[0]?.pickleId,
      )?.pickle;
      expect(selectedPickle?.name).toBe("Payment result second");
    } finally {
      await removeOutlineFixture(fixture);
    }
  });

  test("runs every Outline row when no tag filter is given", async () => {
    const fixture = await createOutlineFixture(
      "test/scripts/specs/fixtures/all.steps.ts",
    );
    try {
      expect(
        await runSpecs(
          { paths: [fixture.featurePath], reports: false },
          fixture.environment,
        ),
      ).toEqual({ success: true });
      expect((await Deno.readTextFile(fixture.runsPath)).split("\n")).toEqual([
        "run",
        "run",
        "",
      ]);
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
});
