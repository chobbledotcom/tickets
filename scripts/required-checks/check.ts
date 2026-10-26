#!/usr/bin/env -S deno run --allow-read=scripts/required-checks --allow-run=gh
/**
 * Fails when the merge queue's required status checks in repository Settings
 * stop matching the manifest at scripts/required-checks/checks.json. Run as
 * part of `deno task precommit`, or on its own with
 * `deno task check:required-checks` (issue #2671).
 */

import * as v from "valibot";
import { consoleOutput } from "#scripts/check-report.ts";
import { captureStdoutOrThrow } from "#scripts/process.ts";
import { manifestSchema, runRequiredChecksCheck } from "./run.ts";

const MANIFEST_PATH = "scripts/required-checks/checks.json";
const RULES_PATH = "repos/chobbledotcom/tickets/rules/branches/main";

/** Reads the live branch rules through the `gh` command line. */
const readRulesWithGh = (): Promise<string> =>
  captureStdoutOrThrow(
    new Deno.Command("gh", {
      args: ["api", RULES_PATH],
      stderr: "piped",
      stdout: "piped",
    }),
    `gh api ${RULES_PATH}`,
  );

const expected = v.parse(
  manifestSchema,
  JSON.parse(await Deno.readTextFile(MANIFEST_PATH)),
);
const rules: unknown = JSON.parse(await readRulesWithGh());
Deno.exit(runRequiredChecksCheck({ expected, output: consoleOutput, rules }));
