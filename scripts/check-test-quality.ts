#!/usr/bin/env -S deno run --allow-read=. --allow-sys --allow-run=git

/**
 * The weak-assertion audit as a pipeline step, escalated in the three steps
 * issue #2298 names: the findings always print (informational), each becomes
 * a `::warning` annotation on GitHub Actions (a CI warning), and a finding in
 * a test file this change touches fails the run (the review gate). Findings
 * elsewhere stay warnings until a change touches their file. See
 * scripts/test-quality-audit.ts for what the patterns are.
 */

import {
  gateReport,
  qualityAnnotations,
  qualityVerdict,
} from "./check-test-quality/report.ts";
import { commandValue, runCommand, runGit } from "./precommit/git.ts";
import { auditTestFiles } from "./test-quality-audit.ts";

/** The test files this change touches, compared with the merge base on
 *  `origin/main`. Only committed work counts, matching the mutation gate's
 *  changed-file set. */
const changedTestFiles = async (): Promise<string[] | null> => {
  const base = await commandValue(runCommand, [
    "merge-base",
    "HEAD",
    "origin/main",
  ]);
  // A checkout without origin/main (a fresh clone) cannot name the change's
  // own files, so the gate skips instead of gating a guessed set.
  if (base === undefined) return null;
  const listed = await runGit(runCommand, [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
  ]);
  if (!listed.success) return null;
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => /\.(?:test|spec)\.tsx?$/.test(file));
};

if (import.meta.main) {
  const findings = await auditTestFiles();
  const changed = await changedTestFiles();
  const verdict = qualityVerdict(findings, changed);
  for (const line of verdict.informational) console.log(line);
  if (Deno.env.get("GITHUB_ACTIONS")) {
    for (const annotation of qualityAnnotations(findings)) {
      console.error(annotation);
    }
  }
  if (verdict.gateSkipped) {
    console.log(
      "The review gate needs origin/main. Run git fetch origin main first.",
    );
  } else if (verdict.gateFindings.length > 0) {
    for (const line of gateReport(verdict.gateFindings)) {
      console.error(line);
    }
    Deno.exit(1);
  }
}
