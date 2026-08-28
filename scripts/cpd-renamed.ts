#!/usr/bin/env -S deno run --allow-all

/**
 * Detect copies that differ only in the words.
 *
 * jscpd's own gate (`.jscpd.json`, minTokens 19) matches literal token runs, so
 * two copies of one operation with different names hide below it: each renamed
 * word breaks the run. This scan runs jscpd one step tighter (17 tokens) and
 * keeps only the pairs whose two sides are the same code with different words
 * — identical punctuation shape, or byte-for-byte equal. Such a pair is the
 * strongest duplication signal the tree can give: someone wrote the same thing
 * twice and renamed it.
 *
 * Fix the pair, or restructure so the shared mechanism exists once. Then the
 * entry leaves the registry. Do not silence this with a registry entry unless
 * the repeat is by design, and say why in the entry's reason.
 *
 * Usage:
 *   deno task cpd:renamed            check (fails on new or stale entries)
 *   deno task cpd:renamed --update   rewrite the registry, keeping known
 *                                    reasons for pairs that did not change
 *
 * The testable half lives in scripts/cpd-renamed/run.ts; this entry only runs
 * jscpd and reports. The registry is scripts/cpd-renamed/allowed.json. An
 * entry that no longer matches any finding is stale — the pair was merged or
 * rewritten — and the check fails until the entry is deleted.
 */

import {
  type JscpdDuplicate,
  runRenamedCloneCheck,
} from "./cpd-renamed/run.ts";
import { commandExitCode, denoNpmArgs } from "./deno-command.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const ROOTS = ["src", "e2e-payments", "scripts"].map(
  (root) => `${ROOT}${root}`,
);
const REGISTRY_FILE = `${ROOT}scripts/cpd-renamed/allowed.json`;

const runJscpd = async (): Promise<JscpdDuplicate[]> => {
  const outputDir = await Deno.makeTempDir({ prefix: "cpd-renamed-" });
  try {
    const config = {
      absolute: false,
      exitCode: 1,
      format: ["javascript", "json", "typescript", "tsx"],
      gitignore: true,
      ignore: [
        "**/node_modules/**",
        "**/package-lock.json",
        "**/deno.lock",
        // The registry repeats one entry shape by design, and this scan runs
        // over scripts/ — keep it out of its own input.
        "**/cpd-renamed/allowed.json",
        "**/fp.ts",
        "**/db/migrations/2*.ts",
        "**/db/migrations/schema/columns.ts",
      ],
      minLines: 1,
      minTokens: 17,
      output: outputDir,
      path: ROOTS,
      reporters: ["json"],
      threshold: 0,
    };
    const configFile = `${outputDir}/config.json`;
    Deno.writeTextFileSync(configFile, JSON.stringify(config));
    // jscpd exits 1 whenever it finds clones at this threshold, which it
    // always does; the pairs themselves are what we want, not its verdict.
    await commandExitCode(Deno.execPath(), {
      args: denoNpmArgs("jscpd@5.0.12", ["--config", configFile]),
      stderr: "null",
      stdout: "null",
    });
    const report = JSON.parse(
      Deno.readTextFileSync(`${outputDir}/jscpd-report.json`),
    );
    return (report.duplicates ?? []) as JscpdDuplicate[];
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
};

const code = await runRenamedCloneCheck({
  duplicates: await runJscpd(),
  output: { log: console.log },
  registryFile: REGISTRY_FILE,
  roots: ROOTS,
  update: Deno.args.includes("--update"),
});
if (code !== 0) Deno.exit(code);
