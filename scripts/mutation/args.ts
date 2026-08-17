/**
 * Pure command-line parsing for `deno task mutation`.
 *
 * This module has no IO — it turns a raw `string[]` of arguments into a
 * validated `ParsedArgs`, recording the first misuse it finds in `error`. The
 * thin CLI shell (`scripts/mutation.ts`) does the glob expansion and running.
 */

/** How long a whole run may take before it is called stuck. Generous on
 *  purpose: this is a guard against a mutant that hangs the tests, not a
 *  performance budget, and it never decides a mutant either way. */
export const DEFAULT_DEADLINE = 60 * 60_000;

export interface ParsedArgs {
  batchJobs?: number;
  deadline: number;
  error: string | null;
  exhaustive: boolean;
  help: boolean;
  sources: string[];
  tests: string[];
  useHarness: boolean;
}

/** Flags that stand alone; each just flips a field on `parsed`. */
const BOOLEAN_FLAGS = new Map<string, (parsed: ParsedArgs) => void>([
  [
    "--exhaustive",
    (parsed) => {
      parsed.exhaustive = true;
    },
  ],
  [
    "--harness",
    (parsed) => {
      parsed.useHarness = true;
    },
  ],
  [
    "-h",
    (parsed) => {
      parsed.help = true;
    },
  ],
  [
    "--help",
    (parsed) => {
      parsed.help = true;
    },
  ],
]);

/**
 * A blank token is not a valid number — `Number("")` and `Number(" ")` are both
 * `0`, which would silently accept `--deadline ""` as a zero deadline. Turn a
 * blank into NaN so the numeric validation rejects it with a clear message.
 */
const toNumber = (value: string): number =>
  value.trim() === "" ? Number.NaN : Number(value);

/** Flags that take a value; each records that value on `parsed`. */
const VALUE_FLAGS = new Map<
  string,
  (parsed: ParsedArgs, value: string) => void
>([
  [
    "--jobs",
    (parsed, value) => {
      parsed.batchJobs = toNumber(value);
    },
  ],
  ["--source", (parsed, value) => parsed.sources.push(value)],
  ["--test", (parsed, value) => parsed.tests.push(value)],
  [
    "--deadline",
    (parsed, value) => {
      parsed.deadline = toNumber(value);
    },
  ],
]);

/** True for any recognised flag — so one option can't be read as another's value. */
const isKnownFlag = (token: string): boolean =>
  BOOLEAN_FLAGS.has(token) || VALUE_FLAGS.has(token);

/**
 * Apply a single argument to `parsed` (or collect it as positional). Returns
 * true when it also consumed `next` as the flag's value. A value flag whose
 * next token is missing OR is itself another option (e.g. `--source --test`)
 * is a usage error, not a silent swallow — otherwise it would surface later as
 * a misleading "no files matched" glob error.
 */
const applyArg = (
  parsed: ParsedArgs,
  positional: string[],
  arg: string,
  next: string | undefined,
): boolean => {
  const setBoolean = BOOLEAN_FLAGS.get(arg);
  if (setBoolean !== undefined) {
    setBoolean(parsed);
    return false;
  }
  const applyValue = VALUE_FLAGS.get(arg);
  if (applyValue === undefined) positional.push(arg);
  else if (next === undefined || isKnownFlag(next)) {
    parsed.error ??= `Missing value for ${arg}.`;
  } else {
    applyValue(parsed, next);
    return true;
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
      // `??=`: a missing-value error from applyArg is the earlier, more useful
      // diagnosis, so keep it rather than overwriting with this one.
      parsed.error ??=
        `Unexpected positional argument(s) alongside --source/--test: ${stray}. ` +
        "A glob likely expanded to multiple files — quote it " +
        `(e.g. --source 'src/shared/forms/*.ts') or pass repeated --source/--test flags.`;
    }
    return;
  }
  if (positional[0] !== undefined) parsed.sources.push(positional[0]);
  if (positional[1] !== undefined) parsed.tests.push(positional[1]);
  if (positional.length > 2) {
    parsed.error ??=
      `Too many positional arguments (${positional.length}). Quote your globs ` +
      `so the shell can't expand them — e.g. 'src/shared/forms/definition.ts' ` +
      `'test/shared/forms/definition/*.test.ts' — or pass repeated ` +
      "--source/--test flags.";
  }
};

/** Validate the parsed numeric options, recording the first error found. */
const validateNumericArgs = (parsed: ParsedArgs): void => {
  if (!Number.isFinite(parsed.deadline) || parsed.deadline <= 0) {
    parsed.error ??=
      "Invalid --deadline: expected a positive number of milliseconds.";
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
    deadline: DEFAULT_DEADLINE,
    error: null,
    exhaustive: false,
    help: false,
    sources: [],
    tests: [],
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
