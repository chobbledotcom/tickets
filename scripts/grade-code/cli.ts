/**
 * The command line for the code grader: resolve the files to grade, run
 * the pipeline, and print one full report or a batch table. Every input a
 * run needs arrives as a dependency, so the tests drive the same code
 * without the network or the repository.
 */

import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import * as v from "valibot";
import { unique } from "#fp";
import type { OverLimit } from "#scripts/check-file-lengths/rules.ts";
import type { Alias } from "#scripts/check-imports/rules.ts";
import { readAliases } from "#scripts/check-imports/run.ts";
import { fetchText } from "#scripts/fetch-text.ts";
import { readTextFileOrNull, statOrNull } from "#scripts/not-found.ts";
import { readJsonOrNull } from "#scripts/read-json.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { collectGateScriptFiles } from "#scripts/walk-files.ts";
import { CHECKS, type GradeContext } from "./checks.ts";
import {
  type GradeCall,
  type GradeDeps,
  gradeCode,
  type JevSettings,
} from "./grade.ts";
import { DEFAULT_MODEL, errorText, loadJevKey } from "./jev.ts";
import {
  batchReportLines,
  type CodeResult,
  csvLines,
  failedCheckIds,
  singleReportLines,
  worstFirst,
} from "./report.ts";

export const USAGE = `Usage: deno task grade:code [targets] [options]

Targets (default: every module under src/):
  src/features/admin/attendee-page.ts   one file, full report
  src/ui/templates/admin                a directory

Options:
  --limit <n>     grade at most n files (at least 1)
  --workers <n>   parallel batch workers (default 4)
  --csv <path>    write batch results to a CSV file
  --json          machine-readable output
  --no-jev        mechanical checks only
  --model <id>    Jev model id (default ${DEFAULT_MODEL})
  --list-checks   print the check schema and exit
  --help          this message

The Jev key is read from OPENCODE_API_KEY or /run/secrets/opencode_api_key.
Batch mode always exits 0. Single-file mode exits 1 on a critical failure.`;

const SECRET_FILE = "/run/secrets/opencode_api_key";
const OVER_LIMIT_PATH = "scripts/check-file-lengths/over-limit.json";
const ALIAS_PATH = "deno.json";
const KNOWN_FLAGS: Record<string, true> = {
  csv: true,
  h: true,
  help: true,
  json: true,
  limit: true,
  "list-checks": true,
  model: true,
  "no-jev": true,
  workers: true,
};

export interface GradeArgs {
  csv: string | null;
  help: boolean;
  json: boolean;
  limit: number;
  listChecks: boolean;
  model: string;
  noJev: boolean;
  targets: string[];
  workers: number;
}

const wholeNumber = (text: string, what: string, lowest: number): number => {
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < lowest) {
    throw new Error(
      `The ${what} value must be a whole number of at least ${lowest}, got: ${text}`,
    );
  }
  return value;
};

export const parseGradeArgs = (args: string[]): GradeArgs => {
  const flags = parseArgs(args, {
    alias: { h: "help" },
    boolean: ["help", "json", "list-checks", "no-jev"],
    string: ["csv", "limit", "model", "workers"],
  });
  for (const key of Object.keys(flags)) {
    if (key !== "_" && KNOWN_FLAGS[key] === undefined) {
      throw new Error(`unknown option --${key}`);
    }
  }
  return {
    csv: flags.csv ?? null,
    help: flags.help === true,
    json: flags.json === true,
    limit:
      flags.limit === undefined ? 0 : wholeNumber(flags.limit, "--limit", 1),
    listChecks: flags["list-checks"] === true,
    model: flags.model ?? DEFAULT_MODEL,
    noJev: flags["no-jev"] === true,
    targets: flags._.map((value) => String(value)),
    workers:
      flags.workers === undefined
        ? 4
        : wholeNumber(flags.workers, "--workers", 1),
  };
};

/** Everything the run reads besides its arguments. */
export interface CliDeps {
  aliases: () => Promise<Alias[] | null>;
  grade: GradeDeps;
  listFiles: (root: string) => Promise<string[]>;
  overLimit: () => Promise<OverLimit | null>;
  readSecret: () => Promise<string | null>;
  stat: (path: string) => Promise<"file" | "dir" | "missing">;
  writeTextFile: (path: string, text: string) => Promise<void>;
}

/** What a path is: a file, a directory, or nothing the grader can target. */
const denoStatKind = async (
  path: string,
): Promise<"file" | "dir" | "missing"> => {
  const info = await statOrNull(path);
  if (info === null) return "missing";
  return info.isDirectory ? "dir" : "file";
};

/** The repository's own files, network, and clock, bound to Deno. */
export const denoCliDeps = (): CliDeps => ({
  aliases: () => readAliases(ALIAS_PATH),
  grade: {
    fetchText,
    now: Date.now,
    readFile: (path) => Deno.readTextFile(path),
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
  },
  listFiles: (root) => collectGateScriptFiles(root),
  overLimit: () =>
    readJsonOrNull(OVER_LIMIT_PATH, v.record(v.string(), v.number())),
  readSecret: () => readTextFileOrNull(SECRET_FILE),
  stat: denoStatKind,
  writeTextFile: (path, text) => Deno.writeTextFile(path, text),
});

export interface ResolvedTargets {
  error: string | null;
  targets: string[];
}

/** Turn command-line targets into module paths under `src/`. */
export const resolveTargets = async (
  args: string[],
  deps: Pick<CliDeps, "listFiles" | "stat">,
): Promise<ResolvedTargets> => {
  const targets: string[] = [];
  const srcRoot = resolve("src");
  // With no target named, the run grades the whole of src/.
  for (const arg of args.length === 0 ? ["src"] : args) {
    // Resolve first, so a traversal such as `src/../scripts` cannot pass the
    // boundary check under the `src/` prefix.
    const target = resolve(arg);
    if (target !== srcRoot && !target.startsWith(`${srcRoot}/`)) {
      return { error: `${arg} is not under src/`, targets: [] };
    }
    const kind = await deps.stat(arg);
    if (kind === "missing") {
      return { error: `cannot read ${arg}`, targets: [] };
    }
    if (kind === "file") {
      targets.push(arg);
      continue;
    }
    const inside = await deps.listFiles(arg);
    if (inside.length === 0) {
      return { error: `no source files under ${arg}`, targets: [] };
    }
    targets.push(...inside);
  }
  // Overlapping targets reach one module twice; it must be graded once.
  return { error: null, targets: unique(targets) };
};

const criticalFailure = (result: CodeResult): boolean =>
  Object.values(result.checks).some(
    (row) => row.critical && row.status === "FAIL",
  );

const progressLine = (
  done: number,
  total: number,
  result: CodeResult,
): string => {
  const fails = failedCheckIds(result);
  const jevFailed = result.jevError === null ? "" : "(Jev failed) ";
  const headline =
    result.score === null
      ? `SKIP ${result.file} - ${result.error.slice(0, 60)}`
      : `${String(result.score).padStart(3)} ${result.letter} ${(
          fails || "-"
        ).slice(0, 60)} ${jevFailed}${result.file}`;
  return `[${done}/${total}] ${headline}`;
};

/** Grade every target in parallel, printing one progress line per file. */
export const runBatch = async (
  io: ScriptIo,
  deps: CliDeps,
  call: GradeCall,
  targets: string[],
  workers: number,
): Promise<CodeResult[]> => {
  const rows: CodeResult[] = [];
  const queue = targets.values();
  let done = 0;
  const runner = async (): Promise<void> => {
    for (const file of queue) {
      const row = await gradeCode(deps.grade, call, file);
      rows.push(row);
      done++;
      io.stderr(progressLine(done, targets.length, row));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, targets.length) }, () => runner()),
  );
  return rows.sort(worstFirst);
};

/** The flags that print their own output and finish the run, or null. */
const exitForInfoFlags = (io: ScriptIo, args: GradeArgs): number | null => {
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!args.listChecks) return null;
  for (const check of CHECKS) {
    const critical = check.critical ? " [CRITICAL]" : "";
    io.stdout(
      `${check.id.padEnd(26)} ${check.engine.padEnd(5)} w${String(
        check.weight,
      ).padEnd(3)} ${check.label}${critical}`,
    );
  }
  return 0;
};

export const runGradeCodeCli = async (
  io: ScriptIo,
  deps: CliDeps = denoCliDeps(),
): Promise<number> => {
  let args: GradeArgs;
  try {
    args = parseGradeArgs(io.args);
  } catch (error) {
    io.stderr(errorText(error));
    io.stderr(USAGE);
    return 2;
  }
  const infoExit = exitForInfoFlags(io, args);
  if (infoExit !== null) return infoExit;
  const { targets, error } = await resolveTargets(args.targets, deps);
  if (error !== null) {
    io.stderr(error);
    return 2;
  }
  const pool = args.limit > 0 ? targets.slice(0, args.limit) : targets;
  const ctx = await loadGradeContext(deps);
  if (ctx === null) {
    io.stderr(`cannot read ${ALIAS_PATH} or ${OVER_LIMIT_PATH}`);
    return 2;
  }
  const call: GradeCall = {
    ctx,
    jev: await jevSettingsFor(io, args, deps.readSecret),
  };

  // A CSV is a batch output, so --csv takes the batch path even for one file.
  if (pool.length === 1 && !args.json && args.csv === null) {
    // The length guard above holds one file; TypeScript cannot see it.
    return gradeSingleCode(io, deps.grade, call, pool[0]!);
  }

  return runSweep(io, deps, args, call, pool);
};

/** The run's Jev settings, or null for a mechanical-only run. A missing key
 * is said once here, so every file in the run is graded the same way. The
 * secret file is read only when Jev is enabled and the environment has no
 * key, so an unreadable file never blocks a mechanical run. */
const jevSettingsFor = async (
  io: ScriptIo,
  args: GradeArgs,
  readSecret: () => Promise<string | null>,
): Promise<JevSettings | null> => {
  if (args.noJev) return null;
  const apiKey = await loadJevKey(io.getEnv, readSecret);
  if (apiKey === null) {
    io.stderr(
      "note: no Jev API key (set OPENCODE_API_KEY); grading mechanical checks only",
    );
    return null;
  }
  return { apiKey, model: args.model };
};

/** The alias table and the accepted-over-limit list, or null when either
 * read failed. */
const loadGradeContext = async (
  deps: Pick<CliDeps, "aliases" | "overLimit">,
): Promise<GradeContext | null> => {
  const aliases = await deps.aliases();
  const overLimit = await deps.overLimit();
  return aliases === null || overLimit === null ? null : { aliases, overLimit };
};

/** Grade one file and print its full report. */
const gradeSingleCode = async (
  io: ScriptIo,
  grade: GradeDeps,
  call: GradeCall,
  file: string,
): Promise<number> => {
  const result = await gradeCode(grade, call, file);
  if (result.score === null) {
    io.stderr(`ERROR grading ${result.file}: ${result.error}`);
    return 2;
  }
  for (const line of singleReportLines(result)) io.stdout(line);
  if (result.jevError !== null) {
    io.stderr(
      `note: Jev unavailable (${result.jevError}); report is mechanical-only`,
    );
  }
  return criticalFailure(result) ? 1 : 0;
};

/** Grade the pool as a batch, then print or write the sweep's output. */
const runSweep = async (
  io: ScriptIo,
  deps: CliDeps,
  args: GradeArgs,
  call: GradeCall,
  pool: string[],
): Promise<number> => {
  const started = deps.grade.now();
  const rows = await runBatch(io, deps, call, pool, args.workers);
  if (args.json) {
    io.stdout(JSON.stringify(rows, null, 2));
  } else {
    for (const line of batchReportLines(rows, {
      model: args.model,
      seconds: (deps.grade.now() - started) / 1000,
    })) {
      io.stdout(line);
    }
  }
  if (args.csv !== null) {
    await deps.writeTextFile(args.csv, `${csvLines(rows).join("\n")}\n`);
    io.stderr(`CSV written to ${args.csv}`);
  }
  return 0;
};
