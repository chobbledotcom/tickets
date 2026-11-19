/**
 * The arguments one cpd scan reads: the flags this repository's wrapper owns,
 * and the rest, which jscpd reads. The wrapper owns its flags because the
 * committed counts are the wrapper's record and jscpd knows nothing of them
 * (see ./counts.ts). WRAPPER_FLAGS names them, and the counts ratchet reads
 * the same names from the scan tasks.
 */

import { requireValue } from "#shared/required-value.ts";

/** What one scan run does. */
export interface ScanOptions {
  /** The arguments to hand jscpd, with the wrapper's own flags removed. */
  args: string[];
  /** Whether the scan fails on a count above the committed count. */
  check: boolean;
  /** The scan config, named by `--config`. */
  config: string;
  /** The committed counts file to read, or undefined when it holds none. */
  counts: string | undefined;
  /** The scan's name in the counts file. */
  scan: string | undefined;
  /** Whether the scan rewrites the counts file from the working tree. */
  update: boolean;
}

/** The names of the flags that the wrapper owns. A scan task writes them, and
 * the counts ratchet reads them from the task, so one declaration names them
 * for both. */
export const WRAPPER_FLAGS = {
  /** Fails a scan that reports more places than the committed count. */
  check: "--fail-on-new-clones",
  /** The committed counts file that the scan reads and writes. */
  counts: "--counts",
  /** The scan's name in the counts file. */
  scan: "--scan",
  /** Writes the committed count from the working tree. */
  update: "--update",
} as const;

/** One wrapper flag that names a value, the noun the value must be, and
 * whether jscpd reads the flag too. */
interface FlagSpec {
  forwards: boolean;
  name: string;
  noun: string;
}

/** The wrapper's flags that name a value. The config goes to jscpd as well. */
const VALUE_FLAGS: readonly FlagSpec[] = [
  { forwards: true, name: "--config", noun: "path" },
  { forwards: false, name: WRAPPER_FLAGS.counts, noun: "path" },
  { forwards: false, name: WRAPPER_FLAGS.scan, noun: "name" },
];

/** The flag that names the config, the one value flag that jscpd reads. */
const CONFIG_NAME = "--config";

/** Whether `arg` is `spec` or the joined `--flag=value` form of it. */
const isFlag = (arg: string, { name }: FlagSpec): boolean =>
  arg === name || arg.startsWith(`${name}=`);

/** One flag's value, and how many arguments it took. */
interface FlagValue {
  consumed: number;
  value: string;
}

/** One flag's value. A value that is empty, or that starts with `-`, is
 * another flag in the value's place, so it fails loudly. */
const checkedValue = ({ name, noun }: FlagSpec, value: string): string => {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`${name} needs a ${noun}.`);
  }
  return value;
};

/** The value one `--flag <value>` or `--flag=<value>` argument names. A flag
 * that names no value fails loudly. */
const valueFlag = (
  spec: FlagSpec,
  arg: string,
  next: string | undefined,
): FlagValue =>
  arg === spec.name
    ? {
        consumed: 2,
        value: checkedValue(
          spec,
          requireValue(next, `${spec.name} needs a ${spec.noun}.`),
        ),
      }
    : {
        consumed: 1,
        value: checkedValue(spec, arg.slice(spec.name.length + 1)),
      };

/** The wrapper's own flags, read from `input`, and the jscpd arguments that
 * remain. A flag that names no value fails loudly, and so does a run that
 * names no config. */
const ownFlags = (input: readonly string[]): ScanOptions => {
  const args: string[] = [];
  /** The value each named flag gave, keyed by the flag's name. */
  const named = new Map<string, string>();
  let check = false;
  let update = false;
  let index = 0;
  while (index < input.length) {
    const arg = requireValue(input[index], "A cpd argument is missing.");
    if (arg === WRAPPER_FLAGS.update) {
      update = true;
      index += 1;
      continue;
    }
    if (arg === WRAPPER_FLAGS.check) {
      check = true;
      index += 1;
      continue;
    }
    const spec = VALUE_FLAGS.find((value) => isFlag(arg, value));
    if (spec === undefined) {
      args.push(arg);
      index += 1;
      continue;
    }
    const read = valueFlag(spec, arg, input[index + 1]);
    named.set(spec.name, read.value);
    if (spec.forwards) args.push(spec.name, read.value);
    index += read.consumed;
  }
  const config = named.get(CONFIG_NAME);
  if (config === undefined) {
    throw new Error("scripts/cpd.ts needs --config <file>");
  }
  return {
    args,
    check,
    config,
    counts: named.get(WRAPPER_FLAGS.counts),
    scan: named.get(WRAPPER_FLAGS.scan),
    update,
  };
};

/** The options of one scan. A scan that checks or updates a count needs both
 * the counts file and the scan name. An update with a check updates: the scan
 * rewrites the count, so there is nothing to check against it. */
export const scanOptions = (input: readonly string[]): ScanOptions => {
  const { args, check, config, counts, scan, update } = ownFlags(input);
  if ((counts === undefined || scan === undefined) && (check || update)) {
    throw new Error(
      `scripts/cpd.ts: ${WRAPPER_FLAGS.update} and ${WRAPPER_FLAGS.check} ` +
        `need ${WRAPPER_FLAGS.counts} <file> and ${WRAPPER_FLAGS.scan} <name>`,
    );
  }
  return { args, check: check && !update, config, counts, scan, update };
};
