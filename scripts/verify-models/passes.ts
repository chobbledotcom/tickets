import { basename, join } from "node:path";
import { checkArgs, type ModelCheck } from "#scripts/verify-models/jobs.ts";
import type { PassStore } from "#scripts/verify-models/run.ts";
import { directoryEntries } from "#scripts/walk-files.ts";
import { requireValue } from "#shared/required-value.ts";
import { sha256Hex } from "#shared/sha256.ts";

/** The source that decides a verdict. A change to any file invalidates every
 *  recorded pass. */
const RULE_FILES = [
  "./check.ts",
  "./run.ts",
  "./jobs.ts",
  "./passes.ts",
  "../verify-models.ts",
  "../walk-files.ts",
] as const;

const PASS_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** One name for the rule that accepts a result and rejects a failure. */
const runnerRule = async (): Promise<string> => {
  const sources = await Promise.all(
    RULE_FILES.map(async (name) => [
      name,
      await Deno.readTextFile(new URL(name, import.meta.url)),
    ]),
  );
  return sha256Hex(JSON.stringify(sources));
};

/** One name for everything that decides a verdict: the acceptance rule, the
 *  checker, the command, the kind of evidence, and each TLA file in the work
 *  directory. */
export const checkKey = async (
  check: ModelCheck,
  checker: string,
  rule: string,
): Promise<string> => {
  const entries = await directoryEntries(check.directory);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile && entry.name.endsWith(".tla"))
      .map((entry) => entry.name)
      .sort()
      .map(async (name) => [
        name,
        await Deno.readTextFile(join(check.directory, name)),
      ]),
  );
  return sha256Hex(
    JSON.stringify([rule, checker, check.kind, checkArgs(check), files]),
  );
};

/** An empty file records each pass under the name of its inputs. The checker
 *  gives one verdict for one set of inputs, so a recorded check does not run
 *  again. */
export const passStore = async (
  directory: string,
  checker: string,
): Promise<PassStore> => {
  await Deno.mkdir(directory, { recursive: true });
  const rule = await runnerRule();
  const entries = await directoryEntries(directory);
  const recorded = new Set(entries.map((entry) => entry.name));
  const file = async (check: ModelCheck): Promise<string> =>
    join(directory, await checkKey(check, checker, rule));
  return {
    known: async (check) => {
      const pass = await file(check);
      if (!recorded.has(basename(pass))) return false;
      const now = new Date();
      await Deno.utime(pass, now, now);
      return true;
    },
    record: async (check) => {
      await Deno.writeTextFile(await file(check), "");
    },
  };
};

/** Remove each pass that no run used for 30 days. */
export const forgetOldPasses = async (
  directory: string,
  now: number,
): Promise<void> => {
  for (const entry of await directoryEntries(directory)) {
    const file = join(directory, entry.name);
    const { mtime } = await Deno.stat(file);
    const used = requireValue(mtime, `The pass ${file} has no change time.`);
    if (now - used.getTime() > PASS_LIFETIME_MS) await Deno.remove(file);
  }
};
