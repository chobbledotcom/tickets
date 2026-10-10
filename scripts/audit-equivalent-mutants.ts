#!/usr/bin/env -S deno run --allow-all

import { relative, resolve } from "@std/path";
import { splitFlagValues } from "#scripts/flag-values.ts";
import {
  auditEquivalentMutants,
  type ReproveContext,
  type ReproveOutcome,
  type ResolvedEntry,
} from "#scripts/mutation/equivalent-audit.ts";
import { reproveEntries } from "#scripts/mutation/equivalent-reproof.ts";
import {
  createFilePlan,
  evaluateMutantTests,
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
import { buildMutationTestMap } from "#scripts/mutation/test-map.ts";
import { projectRoot } from "#scripts/project-root.ts";
/* jscpd:ignore-start -- imports */
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";
/* jscpd:ignore-end -- imports */
import { collectTestFiles } from "#scripts/test-groups.ts";
import { withTestHarness } from "#scripts/test-harness.ts";

const usage = `Usage: deno task mutation:audit-equivalents [--tests] [--write]

Runs lint and type-check against every recorded equivalent mutant without
running tests. Pass --tests to also run each confirmed entry's mapped direct
tests and drop the entries a test kills (a killed mutant is not equivalent).
Pass --write to remove entries that the static checks or the tests now kill.
The audit never re-stamps an entry: re-deriving a proof is a person's read of
the reason against the current file.`;

/** The audit's options. The registry list is internal plumbing: the parent
 * enumerates the shards once and hands the same list to its snapshot child,
 * so the audited files and the copied-back files can never differ. */
interface AuditOptions {
  registry: string[];
  tests: boolean;
  write: boolean;
}

const parseOptions = (args: string[]): AuditOptions => {
  const { rest, values } = splitFlagValues(args, "--registry");
  const registry = values.map((path) => {
    if (!path || path.startsWith("--")) {
      throw new Error(`--registry needs a path\n\n${usage}`);
    }
    return path;
  });
  if (rest.length === 1 && ["-h", "--help"].includes(rest[0]!)) {
    console.log(usage);
    Deno.exit(0);
  }
  if (
    rest.length > 2 ||
    rest.some((arg) => arg !== "--write" && arg !== "--tests")
  ) {
    throw new Error(`Unknown arguments: ${rest.join(" ")}\n\n${usage}`);
  }
  return {
    registry,
    tests: rest.includes("--tests"),
    write: rest.includes("--write"),
  };
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
  console.log(`Killed by lint: ${result.killedByLint.length}`);
  console.log(`Killed by type-check: ${result.killedByTypeCheck.length}`);
  if (options.tests) {
    console.log(`Killed by a test: ${result.killedByTests.length}`);
    console.log(
      `No direct tests to distinguish with: ${result.untested.length}`,
    );
  }
  console.log(`Needs re-derivation: ${result.unconfirmed.length}`);
  console.log(`Still reaches tests: ${result.retained}`);
  if (!options.tests) console.log("No tests were run.");
  for (const line of [
    ...result.killedByLint,
    ...result.killedByTypeCheck,
    ...result.killedByTests,
    ...result.untested,
    ...result.unconfirmed,
  ]) {
    console.log(`  ${line}`);
  }
  const killed =
    result.killedByLint.length +
    result.killedByTypeCheck.length +
    result.killedByTests.length;
  const failed =
    result.unconfirmed.length > 0 || (!options.write && killed > 0);
  return failed ? 1 : 0;
};

/**
 * The distinguishing-input phase as the audit command runs it: the full test
 * harness inside the snapshot, then the sweep over the survivors with the
 * runner's own per-mutant evaluation.
 */
const reproveWithTests = async (
  entries: ResolvedEntry[],
  context: ReproveContext,
): Promise<ReproveOutcome> =>
  withTestHarness(async ({ staticAssets }) => {
    let stateBuilderFiles: Set<string> | null = null;
    const allTestFiles = await collectTestFiles(projectRoot);
    const directTestFiles = new Map(
      buildMutationTestMap(
        entries.map((entry) => entry.file),
        allTestFiles,
      ).targets.map((target) => [target.sourceFile, target.directTestFiles]),
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
  Deno.exit(
    await runInSnapshot({
      args: [...Deno.args, ...registry.flatMap((path) => ["--registry", path])],
      // Only a --write audit rewrites the registry, so only it keeps files.
      copyBack: options.write ? registry : [],
      entryScript: "scripts/audit-equivalent-mutants.ts",
    }),
  );
}
