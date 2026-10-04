#!/usr/bin/env -S deno run --allow-read=. --allow-write=scripts/check-ste/baseline.json
/**
 * Check the policy Markdown against the mechanical simplified-technical-
 * english rules (see the "Simplified Technical English" section of AGENTS.md).
 * Run as part of `deno task precommit`, or on its own with
 * `deno task check:ste`. Pass `--update` after fixing prose to record the
 * step. The update refuses a baseline that rose, so a rise must be fixed
 * first. A removed baseline can no longer be recorded anew.
 */

import * as v from "valibot";
import { consoleOutput } from "./check-report.ts";
import { ratchetedState, registryPath } from "./check-runner.ts";
import {
  freshBaseline,
  MARKDOWN_ROOTS,
  readDocuments,
  runSteCheck,
} from "./check-ste/run.ts";
import { readJsonOrThrow } from "./read-json.ts";

const documents = await readDocuments(".", MARKDOWN_ROOTS);
const records = await readJsonOrThrow(
  registryPath(import.meta.url, "./check-ste/records.json"),
  v.record(v.string(), v.string()),
);
const baseline = await ratchetedState(
  import.meta.url,
  "./check-ste/baseline.json",
  Deno.args,
  () => freshBaseline(documents, records),
);

Deno.exit(runSteCheck(documents, records, baseline, consoleOutput));
