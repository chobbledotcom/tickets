/**
 * The arguments one cpd scan reads: the flags this repository's wrapper owns,
 * and the rest, which jscpd reads. The wrapper owns `--baseline`, `--update`
 * and `--fail-on-new-clones`, because the committed baseline holds content
 * fingerprints that jscpd does not write (see ./baseline.ts).
 */

import { requireValue } from "#shared/required-value.ts";

/** What one scan run does. */
export interface ScanOptions {
  /** The arguments to hand jscpd, with the wrapper's own flags removed. */
  args: string[];
  /** The committed baseline to read, or undefined when the scan holds none. */
  baseline: string | undefined;
  /** Whether the scan fails on a clone the baseline does not hold. */
  check: boolean;
  /** The scan config, named by `--config`. */
  config: string;
  /** Whether the scan rewrites the baseline from the working tree. */
  update: boolean;
}

/** One flag that names a path: its value, and how many arguments it took. */
interface PathFlag {
  consumed: number;
  value: string;
}

/** The path a flag names. A value that is empty, or that starts with `-`, is
 * another flag in the path's place, so it fails loudly. */
const pathValue = (name: string, value: string): string => {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`${name} needs a path.`);
  }
  return value;
};

/** The path one `--flag <path>` or `--flag=<path>` argument names, or
 * undefined when `arg` is another flag. A flag that names no path fails
 * loudly. */
const pathFlag = (
  arg: string,
  name: string,
  next: string | undefined,
): PathFlag | undefined => {
  if (arg === name) {
    const value = requireValue(next, `${name} needs a path.`);
    return { consumed: 2, value: pathValue(name, value) };
  }
  if (!arg.startsWith(`${name}=`)) return;
  return { consumed: 1, value: pathValue(name, arg.slice(name.length + 1)) };
};

/** The flags the wrapper owns, and the arguments that remain for jscpd. */
interface OwnFlags {
  args: string[];
  baseline: string | undefined;
  check: boolean;
  update: boolean;
}

/** The wrapper's own flags, read from `input`, and the jscpd arguments that
 * remain. A path flag that names no path fails loudly. */
const ownFlags = (input: readonly string[]): OwnFlags => {
  const flags: OwnFlags = {
    args: [],
    baseline: undefined,
    check: false,
    update: false,
  };
  let index = 0;
  while (index < input.length) {
    const arg = requireValue(input[index], "A cpd argument is missing.");
    if (arg === "--update") {
      flags.update = true;
      index += 1;
      continue;
    }
    if (arg === "--fail-on-new-clones") {
      flags.check = true;
      index += 1;
      continue;
    }
    const next = input[index + 1];
    const baselineFlag = pathFlag(arg, "--baseline", next);
    if (baselineFlag !== undefined) {
      flags.baseline = baselineFlag.value;
      index += baselineFlag.consumed;
      continue;
    }
    const configFlag = pathFlag(arg, "--config", next);
    if (configFlag === undefined) {
      flags.args.push(arg);
      index += 1;
    } else {
      flags.args.push("--config", configFlag.value);
      index += configFlag.consumed;
    }
  }
  return flags;
};

/** The value of the `--config` flag among `args`, or undefined when the
 * arguments name none. `ownFlags` rejects a flag with no value, so the value
 * follows the flag. */
const configOf = (args: readonly string[]): string | undefined => {
  const index = args.indexOf("--config");
  if (index === -1) return;
  return requireValue(args[index + 1], "--config needs a path.");
};

/** The options of one scan. The run fails loudly when a flag that names a path
 * has none, when `--config` is absent, and when a baseline flag has no
 * baseline. `--update` and `--fail-on-new-clones` together update: the scan
 * rewrites the baseline, so there is nothing to check against it. */
export const scanOptions = (input: readonly string[]): ScanOptions => {
  const { args, baseline, check, update } = ownFlags(input);
  const config = configOf(args);
  if (config === undefined) {
    throw new Error("scripts/cpd.ts needs --config <file>");
  }
  if (baseline === undefined && (check || update)) {
    throw new Error(
      "scripts/cpd.ts: --update and --fail-on-new-clones need --baseline <file>",
    );
  }
  return { args, baseline, check: check && !update, config, update };
};
