#!/usr/bin/env -S deno run --allow-all

import { fromFileUrl, relative, resolve } from "@std/path";
import { splitFlagValues } from "#scripts/flag-values.ts";
import { auditEquivalentMutants } from "#scripts/mutation/equivalent-audit.ts";
import { listRegistryFiles } from "#scripts/mutation/ignore.ts";
import { runInSnapshot } from "#scripts/mutation/isolation.ts";
import {
  isSnapshotChild,
  runSnapshotChild,
} from "#scripts/mutation/snapshot-child.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";

const usage = `Usage: deno task mutation:audit-equivalents [--write]

Runs lint and type-check against every recorded equivalent mutant without
running tests. Pass --write to remove entries that static checks now kill.`;

/** The audit's options. The registry list is internal plumbing: the parent
 * enumerates the shards once and hands the same list to its snapshot child,
 * so the audited files and the copied-back files can never differ. */
interface AuditOptions {
  registry: string[];
  write: boolean;
}

const parseOptions = (args: string[]): AuditOptions => {
  const { rest, values } = splitFlagValues(args, "--registry");
  const registry = values.map((path) => {
    if (!path) throw new Error(`--registry needs a path\n\n${usage}`);
    return path;
  });
  if (rest.length === 1 && ["-h", "--help"].includes(rest[0]!)) {
    console.log(usage);
    Deno.exit(0);
  }
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--write")) {
    throw new Error(`Unknown arguments: ${rest.join(" ")}\n\n${usage}`);
  }
  return { registry, write: rest[0] === "--write" };
};

/** Audit inside this checkout, which the snapshot child owns outright. */
const runAudit = async (options: AuditOptions): Promise<number> => {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  onTerminationSignals(onSignal);
  const result = await auditEquivalentMutants({
    ignoreFiles: options.registry.map((path) => resolve(projectRoot, path)),
    root: projectRoot,
    signal: controller.signal,
    write: options.write,
  })
    .catch((error) => {
      if (controller.signal.aborted) Deno.exit(130);
      throw error;
    })
    .finally(() => offTerminationSignals(onSignal));
  console.log(`Checked ${result.checked} equivalent mutants.`);
  console.log(`Killed by lint: ${result.killedByLint.length}`);
  console.log(`Killed by type-check: ${result.killedByTypeCheck.length}`);
  console.log(`Still reaches tests: ${result.retained}`);
  console.log("No tests were run.");
  for (const line of [...result.killedByLint, ...result.killedByTypeCheck]) {
    console.log(`  ${line}`);
  }
  return !options.write && result.retained !== result.checked ? 1 : 0;
};

/** Project-relative registry paths, listed before snapshotting so a --write
 * audit can carry each pruned file back to the live checkout. */
const registryCopyBackPaths = async (): Promise<string[]> =>
  (await listRegistryFiles()).map((file) =>
    relative(projectRoot, typeof file === "string" ? file : fromFileUrl(file)),
  );

if (import.meta.main) {
  // Parsed here too, so a bad flag or --help answers without copying anything.
  const options = parseOptions(Deno.args);
  if (isSnapshotChild()) {
    Deno.exit(await runSnapshotChild(() => runAudit(options)));
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
