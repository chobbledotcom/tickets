#!/usr/bin/env -S deno run --allow-read --allow-write=scripts/check-ste/baseline.json
/**
 * Check the policy Markdown against the mechanical simplified-technical-
 * english rules (see the "Simplified Technical English" section of AGENTS.md).
 * Run as part of `deno task precommit`, or on its own with
 * `deno task check:ste`. Pass `--update` after fixing prose to re-record the
 * per-document baselines the check ratchets downward.
 */

import * as v from "valibot";
import { consoleOutput } from "./check-report.ts";
import { readCounts } from "./check-runner.ts";
import { findIssues } from "./check-ste/rules.ts";
import { type Baseline, readDocuments, runSteCheck } from "./check-ste/run.ts";
import { readJsonOrThrow, writeJsonFile } from "./read-json.ts";

const RECORDS_PATH = new URL("./check-ste/records.json", import.meta.url)
  .pathname;
const BASELINE_PATH = new URL("./check-ste/baseline.json", import.meta.url)
  .pathname;

const documents = await readDocuments(".", "docs");
const records = await readJsonOrThrow(
  RECORDS_PATH,
  v.record(v.string(), v.string()),
);
const baseline = (await readCounts(BASELINE_PATH)) as Baseline;

if (Deno.args.includes("--update")) {
  const fresh: Baseline = {};
  for (const file of documents) {
    if (records[file.path] === undefined) {
      fresh[file.path] = findIssues(file.content).length;
    }
  }
  await writeJsonFile(BASELINE_PATH, fresh);
}

Deno.exit(runSteCheck(documents, records, baseline, consoleOutput));
