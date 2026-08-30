#!/usr/bin/env -S deno run --allow-read=src,e2e-payments

/**
 * Check that every label the payment e2e clicks or asserts is copy the
 * message catalog renders (or a `t("…")` call into it). The payment run is
 * schedule-only, so without this a copy rename breaks the nightly a day
 * after it merges. Run as part of `deno task precommit`, or on its own.
 */

import { consoleOutput } from "#scripts/check-report.ts";
import {
  CATALOG_DIR,
  runLabelCheck,
  SCAN_ROOT,
} from "./check-e2e-labels/run.ts";

Deno.exit(await runLabelCheck(CATALOG_DIR, SCAN_ROOT, consoleOutput));
