import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  driftFindings,
  manifestSchema,
  requiredContexts,
  runRequiredChecksCheck,
} from "#scripts/required-checks/run.ts";

/** The branch rules as the API returns them for the merge queue today. */
const liveRules = [
  { type: "creation" },
  {
    parameters: {
      required_status_checks: [
        { context: "test", integration_id: 15368 },
        { context: "checks", integration_id: 15368 },
      ],
      strict_required_status_checks_policy: true,
    },
    type: "required_status_checks",
  },
  {
    parameters: { required_files: 1 },
    type: "pull_request_files_required",
  },
];

describe("required checks", () => {
  test("reads the required contexts and ignores the other rules", () => {
    expect(requiredContexts(liveRules)).toEqual(["checks", "test"]);
  });

  test("reads a ruleset with no status-check rule as an empty list", () => {
    expect(requiredContexts([{ type: "creation" }])).toEqual([]);
  });

  test("rejects a response whose check has no context name", () => {
    expect(() =>
      requiredContexts([
        {
          parameters: { required_status_checks: [{ integration_id: 15368 }] },
          type: "required_status_checks",
        },
      ]),
    ).toThrow();
  });

  test("rejects a response that is not a list of rules", () => {
    expect(() => requiredContexts({ type: "creation" })).toThrow();
  });

  test("finds no drift when the manifest and the ruleset agree", () => {
    expect(
      driftFindings({
        expected: ["checks", "test"],
        required: ["test", "checks"],
      }),
    ).toEqual([]);
  });

  test("reports a manifest check the ruleset does not require", () => {
    expect(driftFindings({ expected: ["checks"], required: [] })).toEqual([
      'scripts/required-checks/checks.json [required-check]: "checks" is in the manifest but the main ruleset does not require it — add the required status check in repository Settings, or remove it from the manifest.',
    ]);
  });

  test("reports a required check the manifest does not list", () => {
    expect(driftFindings({ expected: [], required: ["e2e-payments"] })).toEqual(
      [
        'scripts/required-checks/checks.json [required-check]: "e2e-payments" is required by the main ruleset but missing from the manifest — add it to the manifest, or remove the required status check in repository Settings.',
      ],
    );
  });

  test("reports a renamed context as one missing and one extra name", () => {
    const found = driftFindings({
      expected: ["checks"],
      required: ["unit-checks"],
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('"checks"');
    expect(found[1]).toContain('"unit-checks"');
  });

  test("passes when the ruleset requires exactly the manifest names", () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = runRequiredChecksCheck({
      expected: ["checks", "test"],
      output: {
        log: (line) => lines.push(line),
        logError: (line) => errors.push(line),
      },
      rules: liveRules,
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      "The main ruleset requires exactly the checks the manifest lists.",
    ]);
  });

  test("fails and names each drifted name", () => {
    const errors: string[] = [];
    const code = runRequiredChecksCheck({
      expected: ["checks"],
      output: { log: () => {}, logError: (line) => errors.push(line) },
      rules: liveRules,
    });
    expect(code).toBe(1);
    expect(errors.filter((line) => line.includes('"test"'))).toHaveLength(1);
  });

  test("rejects a manifest entry with no name", () => {
    expect(() => v.parse(manifestSchema, ["checks", ""])).toThrow();
  });

  test("rejects a manifest that lists one check twice", () => {
    expect(() => v.parse(manifestSchema, ["checks", "checks"])).toThrow();
  });

  test("records the checks the merge queue requires", async () => {
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(
        await Deno.readTextFile("scripts/required-checks/checks.json"),
      ),
    );
    // Ruleset 21611101 requires the workflow jobs of test.yml: the two static
    // jobs and, since the journeys became hosted evidence, the specs job. The
    // list lives here because repository Settings alone is not reviewable.
    expect(manifest).toEqual(["checks", "specs", "test"]);
  });

  test("lists no name a workflow job cannot emit", async () => {
    // A manifest name no job emits would hold the merge queue for a check
    // that never runs — the silent-drift class issue #2671 names. The
    // live-ruleset gate holds the manifest to Settings; this holds it to the
    // jobs the workflows actually declare.
    const workflow = await Deno.readTextFile(".github/workflows/test.yml");
    const declared = [...workflow.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map(
      (match) => match[1],
    );
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(
        await Deno.readTextFile("scripts/required-checks/checks.json"),
      ),
    );
    for (const name of manifest) {
      expect(
        declared,
        `"${name}" is in the manifest but test.yml declares no job named it`,
      ).toContain(name);
    }
  });
});
