/**
 * Entrypoint for the payment sandbox e2e run — a thin target/Cucumber
 * boundary.
 *
 *   nix develop -c deno task e2e free
 *   nix develop -c deno task e2e stripe
 *   nix develop -c deno task e2e square
 *   nix develop -c deno task e2e sumup
 *
 * Parses the target, validates its secrets (missing paid credentials fail
 * before any browser or provider call), maps the target to its exhaustive
 * case selection, cleans the artifact root and builds static assets once,
 * then hands everything to the repository's shared Cucumber runner. The
 * runner supplies metadata validation, defined order, strict mode, zero
 * retries, reports, and progress output; this boundary only verifies the
 * catalog/count handshake, publishes the result, notifies on failure, and
 * sets the exit status.
 *
 * Exit codes: 0 = executed and passed, 1 = failed.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@cucumber/messages";
import {
  appendStepSummary,
  publishExecutedResult,
} from "#scripts/github-actions.ts";
import { runSpecs } from "#scripts/specs/run.ts";
import { providerSecrets } from "./config.ts";
import { failRun, runHarness } from "./entry.ts";
import { log, step } from "./log.ts";
import { notifyFailure } from "./notify.ts";
import { artifactsRoot, buildStaticAssets } from "./server.ts";
import {
  caseExpression,
  LIVE_FEATURE_PATH,
  type LiveTarget,
  parseLiveTarget,
  TARGET_CASES,
  verifyCatalogTargets,
  verifyExecutedCases,
} from "./targets.ts";

/** The target string this run was asked for, for the failure notification
 * even when parsing it (or anything after it) throws. */
const requestedTarget = (): string =>
  process.argv[2] ?? process.env.E2E_PROVIDER ?? "free";

interface JournalSummary {
  caseId: string;
  finalLocalState: string | null;
  pendingObserved: boolean;
}

/** The concise, truthful per-case outcome table for the job summary. */
const writeStepSummary = (target: LiveTarget): void => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const journals = readdirSync(artifactsRoot)
    .filter((name) => name.endsWith("-journal.json"))
    .sort();
  const rows = journals.map((name) => {
    try {
      const journal = JSON.parse(
        readFileSync(join(artifactsRoot, name), "utf8"),
      ) as JournalSummary;
      const outcome = journal.finalLocalState ?? "no refund outcome";
      const pending = journal.pendingObserved
        ? " (pending genuinely observed)"
        : "";
      return `${journal.caseId} | ${target} | ${outcome}${pending} | ${name}`;
    } catch {
      return `(unreadable journal) | ${target} | unknown | ${name}`;
    }
  });
  const table = [
    "case | provider | outcome | journal",
    "--- | --- | --- | ---",
    ...rows,
  ].join("\n");
  appendStepSummary(`\n## Live payment cases (${target})\n\n${table}\n`);
};

const publishResult = (): void => {
  log("RESULT: executed");
  publishExecutedResult();
};

const run = async (): Promise<void> => {
  const target = parseLiveTarget(requestedTarget());
  step(`Payment sandbox e2e — target: ${target}`);

  // A paid target without its secrets is a failed nightly contract, not a
  // skip: this throws before any browser or provider call.
  if (target !== "free") {
    providerSecrets(target);
  }

  // The artifact root is cleaned here, BEFORE the Cucumber formatters open
  // their report files — cleaning inside a hook could delete the live reports.
  rmSync(artifactsRoot, { force: true, recursive: true });
  await buildStaticAssets();

  const cases = TARGET_CASES[target];
  const summary = await runSpecs(
    { paths: [LIVE_FEATURE_PATH], tags: caseExpression(cases) },
    {
      env: { E2E_PROVIDER: target },
      reportDir: join(artifactsRoot, "cucumber"),
      support: [
        "e2e-payments/src/cucumber/support/**/*.ts",
        "e2e-payments/src/cucumber/steps/**/*.ts",
      ],
    },
    {
      beforeRun: (catalog) => verifyCatalogTargets(catalog),
      onSuccess: (messages: Envelope[]) => verifyExecutedCases(messages, cases),
      // e2e-payments/.tmp is a fixed path, so scenarios must not overlap.
      parallel: 1,
    },
  );

  writeStepSummary(target);
  if (!summary.success) {
    await failRun(`FAIL — ${target}: the Cucumber run reported failures`, () =>
      notifyFailure(target),
    );
    return;
  }
  publishResult();
  step(`PASS — ${target}: ${cases.length} case(s) executed`);
};

runHarness(run, () => notifyFailure(requestedTarget()));
