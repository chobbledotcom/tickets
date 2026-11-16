#!/usr/bin/env -S deno run --allow-all

/**
 * jscpd runner that prints actionable guidance when duplication is found.
 *
 * jscpd's own console report tells you *where* the duplication is, but not what
 * to do about it. This wrapper runs jscpd unchanged and forwards every arg, then
 * — only on a non-zero exit — appends a loud reminder of the project's
 * no-new-duplication policy: extract a helper, or curry, and reserve
 * `jscpd:ignore` for unavoidable boilerplate. The configs skip imports.
 *
 * After every scan it also names the worst duplication in the report: the
 * code that appears in the most places, then the one with the most tokens.
 *
 * The wrapper owns the committed baseline. jscpd's own baseline hashes the raw
 * source text of a clone pair, so a blank line inside a duplicated block
 * changes the fingerprint. This baseline holds one whitespace-free content
 * fingerprint per duplicated snippet, with a count per place (see
 * ./jscpd/baseline.ts). `--update` rewrites it and `--fail-on-new-clones`
 * checks the scan against it.
 *
 * Usage: deno run -A scripts/cpd.ts <jscpd args...>
 */

import { resolve } from "node:path";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type Baseline,
  baselineText,
  placeLines,
  readBaseline,
  rises,
  type ScanFingerprints,
  scanFingerprints,
  updateSummary,
  versionMismatch,
} from "./jscpd/baseline.ts";
import { ensureJscpd } from "./jscpd/install.ts";
import { scanOptions } from "./jscpd/options.ts";
import {
  describeWorstFamily,
  type Place,
  rankCloneFamilies,
  readClonePairs,
} from "./jscpd/worst.ts";
import { bold, red, yellow } from "./precommit/colors.ts";

/** How many places one finding shows before it counts the rest. */
const PLACES_SHOWN = 5;

const options = scanOptions(Deno.args);
const baselinePath =
  options.baseline === undefined
    ? undefined
    : resolve(projectRoot, options.baseline);

/** The report that this scan writes, read from the config that `--config`
 * names. jscpd writes `output` from the working directory, so the report sits
 * under the project root. */
const reportPath = async (): Promise<string> => {
  const { output } = v.parse(
    v.object({ output: v.string() }),
    JSON.parse(await Deno.readTextFile(options.config)),
  );
  return resolve(projectRoot, output, "jscpd-report.json");
};

const report = await reportPath();
// A crash before jscpd writes its report must not show the last run's report.
await Deno.remove(report).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

const { code } = await new Deno.Command(await ensureJscpd(), {
  args: options.args,
}).spawn().status;

const pairs = readClonePairs(JSON.parse(await Deno.readTextFile(report)));
const families = rankCloneFamilies(pairs);
console.error(
  yellow(describeWorstFamily(options.config, families, projectRoot).join("\n")),
);

/** The source text of every place, with each file read once. */
const readSnippet = (() => {
  const files = new Map<string, string[]>();
  return (place: Place): string => {
    const cached = files.get(place.file);
    if (cached !== undefined) return placeLines(cached, place);
    const lines = Deno.readTextFileSync(place.file).split(/\r?\n/);
    files.set(place.file, lines);
    return placeLines(lines, place);
  };
})();

/** The baseline file this scan remembers, or undefined when it holds none. */
const rememberedBaseline = async (): Promise<Baseline | undefined> => {
  const path = requireValue(
    baselinePath,
    "A cpd scan with a baseline needs --baseline <file>.",
  );
  const text = await Deno.readTextFile(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  });
  return text === undefined ? undefined : readBaseline(path, text);
};

/** The lines that name each new clone and the count it rose above. */
const newCloneLines = (
  scan: ScanFingerprints,
  base: Baseline["counts"],
): string[] => {
  const lines: string[] = [];
  for (const [fingerprint, count] of rises(scan.counts, base)) {
    const places = requireValue(
      scan.places[fingerprint],
      `The scan reported no place for the fingerprint ${fingerprint}.`,
    );
    lines.push(
      `  ${count} place(s), up from ${base[fingerprint] ?? 0}:`,
      ...places
        .slice(0, PLACES_SHOWN)
        .map((place) => `    ${place.file}:${place.start}-${place.end}`),
      ...(places.length > PLACES_SHOWN
        ? [`    and ${places.length - PLACES_SHOWN} more places.`]
        : []),
    );
  }
  return lines;
};

const scan = await scanFingerprints(pairs, readSnippet);
const newClones = await (async (): Promise<string[]> => {
  if (!options.update && !options.check) return [];
  const before = await rememberedBaseline();
  if (options.update) {
    const named = requireValue(
      options.baseline,
      "A rewrite needs --baseline <file>.",
    );
    await Deno.writeTextFile(
      resolve(projectRoot, named),
      baselineText(scan.counts),
    );
    console.error(yellow(updateSummary(named, scan.counts, before)));
    return [];
  }
  if (before === undefined) {
    throw new Error(
      `The jscpd baseline ${options.baseline} does not exist. ` +
        "Run the cpd task with --update to write it.",
    );
  }
  const mismatch = versionMismatch(before);
  if (mismatch !== undefined) {
    throw new Error(
      `The jscpd baseline ${options.baseline} ${mismatch}. ` +
        "Run the cpd task with --update to refresh it.",
    );
  }
  return newCloneLines(scan, before.counts);
})();

if (newClones.length > 0) {
  console.error(`
${bold(red("━━━ jscpd: new duplicated code not in the baseline ━━━"))}

${options.baseline} does not hold:
${newClones.join("\n")}`);
}

if (code !== 0 || newClones.length > 0) {
  console.error(`
${bold(red("━━━ jscpd: duplicated code found — no new duplication is allowed ━━━"))}

Do NOT reach for ${bold("/* jscpd:ignore */")} to silence this. Fix the duplication:

  ${bold("1. Write a helper.")} This is the answer in ~99.999% of cases. If an
     obvious shared function jumps out, extract it and call it from both sites.

  ${bold("2. No obvious helper? Curry.")} Lift the parts that differ into
     arguments of a function that returns the specialised version, then call it
     at each site. ${yellow("Then review your work before committing")} — zoom out
     one step further. The first small curry you reach for is often not the
     best one; a larger, more holistic curry across the call sites is very
     frequently far better.

  ${bold("3. jscpd:ignore is the LAST resort.")} The configs already skip import
     and re-export statements, so imports never need a marker. Keep a marker
     for the rare unavoidable scrap of boilerplate/infrastructure we have no
     control over. Anywhere else an ignore tag is a code smell, not a fix.

  ${yellow("Never restructure the code just to break the token match")} (a
     config object, a rename, reordering) while two parallel implementations
     stay standing. That hides the signal and keeps the duplication. The
     question is "how do I make these two things one thing", not "how do I
     make jscpd stop flagging this".
`);
}

Deno.exit(code !== 0 ? code : newClones.length > 0 ? 1 : 0);
