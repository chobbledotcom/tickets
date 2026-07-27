/**
 * A throwaway Feature with two Outline examples, plus the folders a run needs,
 * so a test can drive a real Cucumber run without touching the real specs.
 */

import type { SpecRunEnvironment } from "#scripts/specs/run.ts";
import { SPEC_RUNS_PATH_ENV } from "#test/scripts/specs/fixtures/record-step.ts";

export interface OutlineFixture {
  directory: string;
  environment: SpecRunEnvironment;
  featurePath: string;
  runsPath: string;
}

export const createOutlineFixture = async (
  support: string,
): Promise<OutlineFixture> => {
  const directory = await Deno.makeTempDir();
  const featurePath = `${directory}/outline.feature`;
  const runsPath = `${directory}/runs.txt`;
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
    environment: {
      env: { [SPEC_RUNS_PATH_ENV]: runsPath },
      reportDir: `${directory}/reports`,
      support: [support],
    },
    featurePath,
    runsPath,
  };
};

export const removeOutlineFixture = async (
  fixture: OutlineFixture,
): Promise<void> => {
  await Deno.remove(fixture.directory, { recursive: true });
};
