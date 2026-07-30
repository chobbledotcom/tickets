#!/usr/bin/env -S deno run --allow-all

import { fromFileUrl, relative } from "@std/path";
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

const parseOptions = (args: string[]): { write: boolean } => {
  if (args.length === 0) return { write: false };
  if (args.length === 1 && args[0] === "--write") {
    return { write: true };
  }
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    console.log(usage);
    Deno.exit(0);
  }
  throw new Error(`Unknown arguments: ${args.join(" ")}\n\n${usage}`);
};

/** Audit inside this checkout, which the snapshot child owns outright. */
const runAudit = async (options: { write: boolean }): Promise<number> => {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  onTerminationSignals(onSignal);
  const result = await auditEquivalentMutants({
    ...options,
    ignoreFiles: await listRegistryFiles(),
    root: projectRoot,
    signal: controller.signal,
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
  Deno.exit(
    isSnapshotChild()
      ? await runSnapshotChild(() => runAudit(options))
      : await runInSnapshot({
          args: Deno.args,
          // Only a --write audit rewrites the registry, so only it keeps files.
          copyBack: options.write ? await registryCopyBackPaths() : [],
          entryScript: "scripts/audit-equivalent-mutants.ts",
        }),
  );
}
