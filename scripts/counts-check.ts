#!/usr/bin/env -S deno run --allow-read=src,test,scripts,cli,e2e-payments --allow-write=scripts/check-file-lengths/over-limit.json,scripts/check-presence-assertions/registry.json

/**
 * One entry behind every flat-counts ratchet check. The deno task names the
 * check and carries its read and write permissions; this script wires the
 * check's registry, its roots, and its run. The first argument names the
 * check, and the rest go to the record step: `--update` after a fix records
 * the fallen counts, and the update refuses a rise. Run as part of
 * `deno task precommit`, or on its own through the `check:` task per check.
 */

import { SOURCE_DIRS } from "#scripts/source-dirs.ts";
import {
  filesOverLimit,
  runFileLengthCheck,
} from "./check-file-lengths/run.ts";
import {
  filesWithPresence,
  runPresenceCheck,
} from "./check-presence-assertions/run.ts";
import {
  type Counts,
  type CountsCheck,
  countsCheckExit,
} from "./check-runner.ts";

/** The checks this entry serves, named the way the deno tasks pass them. */
type CheckName = "file-lengths" | "presence-assertions";

/** One check's wiring: the registry beside this script, the roots the check
 * reads, and the fresh-count and run legs. */
type CountsCheckWiring = {
  fresh: (roots: readonly string[]) => Promise<Counts>;
  relative: string;
  roots: readonly string[];
  run: CountsCheck;
};

/** One wiring per check name. */
const WIRING: Record<CheckName, CountsCheckWiring> = {
  "file-lengths": {
    fresh: filesOverLimit,
    relative: "./check-file-lengths/over-limit.json",
    roots: SOURCE_DIRS,
    run: runFileLengthCheck,
  },
  "presence-assertions": {
    fresh: filesWithPresence,
    relative: "./check-presence-assertions/registry.json",
    roots: ["test"],
    run: runPresenceCheck,
  },
};

const [name, ...args] = Deno.args;

/** Whether `name` names a check this entry serves. */
const isCheckName = (candidate: string | undefined): candidate is CheckName =>
  candidate !== undefined && candidate in WIRING;

if (!isCheckName(name)) {
  console.error(
    `Unknown counts check: ${name ?? "(none)"}. Name one of: ${Object.keys(
      WIRING,
    ).join(", ")}.`,
  );
  Deno.exit(2);
}

const wiring = WIRING[name];

Deno.exit(
  await countsCheckExit(
    import.meta.url,
    wiring.relative,
    args,
    wiring.roots,
    wiring.fresh,
    wiring.run,
  ),
);
