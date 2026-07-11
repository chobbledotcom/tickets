/**
 * Pure command-line parsing for `deno task mutation`.
 *
 * This module has no IO — it turns a raw `string[]` of arguments into a
 * validated `ParsedArgs`, recording the first misuse it finds in `error`. The
 * thin CLI shell (`scripts/mutation.ts`) does the glob expansion and running.
 */

export const DEFAULT_TIMEOUT = 10_000;

export interface ParsedArgs {
  batchJobs?: number;
  error: string | null;
  exhaustive: boolean;
  help: boolean;
  sources: string[];
  tests: string[];
  timeout: number;
  useHarness: boolean;
}

type ValueFlagApply = (parsed: ParsedArgs, value: string) => void;

/** Options that take a value; maps the flag to how it records its value. */
const VALUE_FLAGS: Record<string, ValueFlagApply | undefined> = {
  "--jobs": (parsed, value) => {
    parsed.batchJobs = Number(value);
  },
  "--source": (parsed, value) => parsed.sources.push(value),
  "--test": (parsed, value) => parsed.tests.push(value),
  "--timeout": (parsed, value) => {
    parsed.timeout = Number(value);
  },
};

/**
 * Apply a single argument to `parsed` (or collect it as positional). Returns
 * true when it also consumed `next` as the flag's value. A value flag with no
 * following token (it was the last argument) is a usage error, not a
 * positional — otherwise it would surface later as a misleading "no files
 * matched" glob error.
 */
const applyArg = (
  parsed: ParsedArgs,
  positional: string[],
  arg: string,
  next: string | undefined,
): boolean => {
  if (arg === "--exhaustive") parsed.exhaustive = true;
  else if (arg === "--harness") parsed.useHarness = true;
  else if (arg === "-h" || arg === "--help") parsed.help = true;
  else {
    const applyValue = VALUE_FLAGS[arg];
    if (applyValue === undefined) positional.push(arg);
    else if (next === undefined) parsed.error = `Missing value for ${arg}.`;
    else {
      applyValue(parsed, next);
      return true;
    }
  }
  return false;
};

/** Fold positional arguments into `parsed`, recording an error on misuse. */
const applyPositionals = (parsed: ParsedArgs, positional: string[]): void => {
  const usedFlagForm = parsed.sources.length > 0 || parsed.tests.length > 0;
  if (usedFlagForm) {
    // Flag-form was used: positionals are not part of the grammar. Any leftover
    // means a glob expanded past the single value --source/--test consumed
    // (e.g. `--source src/*.ts` → src/a.ts src/b.ts …), which would silently
    // narrow the run. Reject rather than drop the extras.
    if (positional.length > 0) {
      const stray = positional.join(", ");
      parsed.error =
        `Unexpected positional argument(s) alongside --source/--test: ${stray}. ` +
        "A glob likely expanded to multiple files — quote it " +
        `(e.g. --source 'src/lib/forms/*.ts') or pass repeated --source/--test flags.`;
    }
    return;
  }
  if (positional[0] !== undefined) parsed.sources.push(positional[0]);
  if (positional[1] !== undefined) parsed.tests.push(positional[1]);
  if (positional.length > 2) {
    parsed.error =
      `Too many positional arguments (${positional.length}). Quote your globs ` +
      `so the shell can't expand them — e.g. 'src/lib/forms/*.ts' ` +
      `'test/lib/forms/*.test.ts' — or pass repeated --source/--test flags.`;
  }
};

/** Validate the parsed numeric options, recording the first error found. */
const validateNumericArgs = (parsed: ParsedArgs): void => {
  if (!Number.isFinite(parsed.timeout) || parsed.timeout < 0) {
    parsed.error ??=
      "Invalid --timeout: expected a non-negative number of milliseconds.";
  }
  const invalidJobs =
    parsed.batchJobs !== undefined &&
    (!Number.isInteger(parsed.batchJobs) || parsed.batchJobs <= 0);
  if (invalidJobs) {
    parsed.error ??= "Invalid --jobs: expected a positive integer.";
  }
};

export const parseArgs = (args: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    error: null,
    exhaustive: false,
    help: false,
    sources: [],
    tests: [],
    timeout: DEFAULT_TIMEOUT,
    useHarness: false,
  };
  const positional: string[] = [];
  const remaining = [...args];
  let arg = remaining.shift();
  while (arg !== undefined) {
    const consumedNext = applyArg(parsed, positional, arg, remaining[0]);
    if (consumedNext) remaining.shift();
    arg = remaining.shift();
  }
  applyPositionals(parsed, positional);
  validateNumericArgs(parsed);
  return parsed;
};
