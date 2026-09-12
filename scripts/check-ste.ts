#!/usr/bin/env -S deno run --allow-read --allow-write=scripts/check-ste/baseline.json
/**
 * Check the policy Markdown against the mechanical simplified-technical-
 * english rules (see the "Simplified Technical English" section of AGENTS.md).
 * Run as part of `deno task precommit`, or on its own with
 * `deno task check:ste`. Pass `--update` after fixing prose to record the
 * step; it refuses to write a baseline that rose, so a rise must be fixed
 * first. Pass `--seed` only when the rules themselves changed and the
 * baseline must be recorded anew.
 */

import * as v from "valibot";
import { consoleOutput } from "./check-report.ts";
import { recordedState, updateMode } from "./check-runner.ts";
import {
  baselineRose,
  freshBaseline,
  MARKDOWN_ROOTS,
  readDocuments,
  runSteCheck,
} from "./check-ste/run.ts";
import { readJsonOrThrow } from "./read-json.ts";

const RECORDS_PATH = new URL("./check-ste/records.json", import.meta.url)
  .pathname;
const BASELINE_PATH = new URL("./check-ste/baseline.json", import.meta.url)
  .pathname;

const documents = await readDocuments(".", MARKDOWN_ROOTS);
const records = await readJsonOrThrow(
  RECORDS_PATH,
  v.record(v.string(), v.string()),
);
const baseline = await recordedState(
  BASELINE_PATH,
  updateMode(Deno.args),
  await readJsonOrThrow(
    BASELINE_PATH,
    v.record(v.string(), v.record(v.string(), v.number())),
  ),
  () => freshBaseline(documents, records),
  baselineRose,
);

Deno.exit(runSteCheck(documents, records, baseline, consoleOutput));
