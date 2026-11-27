#!/usr/bin/env -S deno run --allow-all

import { relative, resolve } from "@std/path";
import { splitFlagValues } from "#scripts/flag-values.ts";
import {
  auditEquivalentMutants,
  type ReproveContext,
  type ReproveOutcome,
} from "#scripts/mutation/equivalent-audit.ts";
import type { ResolvedEntry } from "#scripts/mutation/equivalent-registry.ts";
import { reproveEntries } from "#scripts/mutation/equivalent-reproof.ts";
import { renewEquivalentMutants } from "#scripts/mutation/equivalent-review.ts";
import {
  createFilePlan,
  evaluateMutantTests,
  evaluateOriginalTests,
} from "#scripts/mutation/evaluate.ts";
import { createStaticGates, testEnv } from "#scripts/mutation/execution.ts";
import {
  listRegistryFiles,
  registryFilePath,
} from "#scripts/mutation/ignore.ts";
import { runInSnapshot } from "#scripts/mutation/isolation.ts";
import { defaultBatchJobs } from "#scripts/mutation/runner.ts";
import {
  isSnapshotChild,
  runSnapshotChild,
} from "#scripts/mutation/snapshot-child.ts";
import { collectStateBuilderFiles } from "#scripts/mutation/state-graph.ts";
import { directTestMapFor } from "#scripts/mutation/test-map.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";
import { collectTestFiles } from "#scripts/test-groups.ts";
import { withTestHarness } from "#scripts/test-harness.ts";

const usage = `Usage:
  deno task mutation:audit-equivalents [--source <path>]... [--tests] [--write]
  deno task mutation:audit-equivalents --source <path> [--source <path>]... --renew <token> [--renew <token>]...

Preview by default. Use --source to select exact project-relative paths.
Use --tests to include mapped direct tests. Use --write to delete records
with no exact mutant or a mutant that a check kills.
After you review a proof, use --renew with its reported renewal token.
Renewal does not run checks and never deletes records.`;

/** The audit's options. The registry list is internal plumbing: the parent
 * enumerates the shards once and hands the same list to its snapshot child,
 * so the audited files and the copied-back files can never differ. */
interface AuditOptions {
  registry: string[];
  renew: string[];
  sources: string[];
  tests: boolean;
  write: boolean;
}

const takeValues = (args: string[], flag: string) => {
  const { rest, values } = splitFlagValues(args, flag);
  return {
    rest,
    values: values.map((value) => {
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} needs a value.\n\n${usage}`);
      }
      return value;
    }),
  };
};

const parseOptions = (args: string[]): AuditOptions => {
  const [first] = args;
  if (args.length === 1 && (first === "-h" || first === "--help")) {
    console.log(usage);
    Deno.exit(0);
  }
  const registry = takeValues(args, "--registry");
  const sources = takeValues(registry.rest, "--source");
  const { rest, values: renew } = takeValues(sources.rest, "--renew");
  if (rest.some((arg) => arg !== "--write" && arg !== "--tests")) {
    throw new Error(`Unknown arguments: ${rest.join(" ")}\n\n${usage}`);
  }
  if (renew.length > 0) {
    if (sources.values.length === 0 || rest.length > 0) {
      throw new Error(`Use --renew with --source only.\n\n${usage}`);
    }
    if (renew.some((token) => !/^[0-9a-f]{64}$/.test(token))) {
      throw new Error("Use a renewal token from the audit report.");
    }
  }
  return {
    registry: registry.values,
    renew,
    sources: sources.values,
    tests: rest.includes("--tests"),
    write: rest.includes("--write"),
  };
};

const reportEntries = (label: string, lines: string[]): void => {
  console.log(`${label}: ${lines.length}`);
  for (const line of lines) console.log(`  ${line}`);
};

/** Audit inside this checkout, which the snapshot child owns outright. */
const runAudit = async (options: AuditOptions): Promise<number> => {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  onTerminationSignals(onSignal);
  const result = await auditEquivalentMutants(
    {
      ignoreFiles: options.registry.map((path) => resolve(projectRoot, path)),
      root: projectRoot,
      signal: controller.signal,
      sources: options.sources,
      write: options.write,
    },
    {
      createGates: createStaticGates,
      ...(options.tests ? { reprove: reproveWithTests } : {}),
    },
  )
    .catch((error) => {
      // An interrupt must return through the snapshot child's cleanup, not
      // exit straight past it — an exit here would leave the run's claim
      // reading as live until it aged out on its own.
      if (controller.signal.aborted) return null;
      throw error;
    })
    .finally(() => offTerminationSignals(onSignal));
  if (result === null) return 130;
  console.log(`Checked ${result.checked} equivalent mutants.`);
  const removals = [
    ["No exact mutant", result.missing],
    ["Killed by lint", result.killedByLint],
    ["Killed by type-check", result.killedByTypeCheck],
    ...(options.tests
      ? [["Killed by a test", result.killedByTests] as const]
      : []),
  ] as const;
  for (const [label, lines] of removals) {
    reportEntries(label, lines);
  }
  if (options.tests) {
    reportEntries("No mapped direct tests", result.untested);
  } else {
    console.log("No tests were run.");
  }
  console.log(`Needs proof review: ${result.unconfirmed.length}`);
  for (const review of result.unconfirmed) {
    console.log(`  ${review.key}`);
    console.log(`  ${review.location}: ${review.excerpt}`);
    console.log(`  Reason: ${review.reason}`);
    console.log(`  Renewal token: ${review.token}`);
  }
  console.log(`Retained: ${result.retained}`);
  const deletionsPending =
    !options.write && removals.some(([, lines]) => lines.length > 0);
  const failed = deletionsPending || result.unconfirmed.length > 0;
  return failed ? 1 : 0;
};

const reproveWithTests = async (
  entries: ResolvedEntry[],
  context: ReproveContext,
): Promise<ReproveOutcome> =>
  withTestHarness(async ({ staticAssets }) => {
    let stateBuilderFiles: Set<string> | null = null;
    const allTestFiles = await collectTestFiles(projectRoot);
    const directTestFiles = directTestMapFor(
      entries.map((entry) => entry.file),
      allTestFiles,
    );
    return reproveEntries(
      entries,
      {
        batchJobs: defaultBatchJobs(),
        createPlan: async (file, testFiles) => {
          // The harness exports the prebuilt state's directory only once it is
          // up, so the state-feeding files are named on the first plan.
          stateBuilderFiles ??= await collectStateBuilderFiles();
          return await createFilePlan(
            staticAssets,
            stateBuilderFiles,
            true,
            file,
            testFiles,
          );
        },
        directTestFiles: (files) =>
          Promise.resolve(
            new Map(
              files.map((file) => [file, directTestFiles.get(file) ?? []]),
            ),
          ),
        env: testEnv(),
        evaluate: (plan, mutant, run, signal) =>
          // Integration tests never run here: only a direct-test kill can
          // disprove an entry, and survivors stand either way.
          evaluateMutantTests(plan, mutant, run, [], signal, []),
        evaluateBaseline: (plan, run, signal) =>
          evaluateOriginalTests(plan, run, signal),
      },
      context.signal,
    );
  });

/** Project-relative registry paths, listed before snapshotting so a --write
 * audit can carry each pruned file back to the live checkout. */
const registryCopyBackPaths = async (): Promise<string[]> =>
  (await listRegistryFiles()).map((file) =>
    relative(projectRoot, registryFilePath(file)),
  );

if (import.meta.main) {
  // Parsed here too, so a bad flag or --help answers without copying anything.
  const options = parseOptions(Deno.args);
  if (isSnapshotChild()) {
    Deno.exit(await runSnapshotChild(() => runAudit(options)));
  }
  // The manifest is the parent's to build: a hand-passed file would be
  // audited in the snapshot yet never copied back, so refuse it outright.
  if (options.registry.length > 0) {
    throw new Error(`--registry is internal to the audit\n\n${usage}`);
  }
  // One shard list serves the audit and the copy-back alike, so a shard added
  // while the snapshot is being made can never be pruned and then lost.
  const registry = await registryCopyBackPaths();
  if (options.renew.length > 0) {
    const count = await renewEquivalentMutants(
      { ignoreFiles: registry, root: projectRoot, sources: options.sources },
      options.renew,
    );
    console.log(`Renewed ${count} equivalent-mutant proofs.`);
    Deno.exit(0);
  }
  Deno.exit(
    await runInSnapshot({
      args: [...Deno.args, ...registry.flatMap((path) => ["--registry", path])],
      // Only a --write audit rewrites the registry, so only it keeps files.
      copyBack: options.write ? registry : [],
      entryScript: "scripts/audit-equivalent-mutants.ts",
    }),
  );
}
