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
 * The wrapper owns the committed counts. `cfg/cpd-counts.json` holds one number
 * for each scan: how many duplicated places the scan reports (see
 * ./jscpd/counts.ts). `--update` writes the number and refuses a rise, and
 * `--fail-on-new-clones` fails the scan when its report holds more places than
 * the committed count.
 *
 * Usage: deno run -A scripts/cpd.ts <jscpd args...>
 */

import { resolve } from "node:path";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import { writeJsonFile } from "#scripts/read-json.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  placeCount,
  readCounts,
  type ScanCounts,
  updatedCounts,
  updateSummary,
} from "./jscpd/counts.ts";
import { ensureJscpd } from "./jscpd/install.ts";
import { scanOptions } from "./jscpd/options.ts";
import {
  describeWorstFamily,
  rankCloneFamilies,
  readClonePairs,
} from "./jscpd/worst.ts";
import { bold, red, yellow } from "./precommit/colors.ts";

const options = scanOptions(Deno.args);

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
const worstLines = describeWorstFamily(
  options.config,
  rankCloneFamilies(pairs),
  projectRoot,
);

/** The committed counts file this scan reads, or undefined when the file is
 * not there. */
const rememberedCounts = async (): Promise<ScanCounts | undefined> => {
  const path = requireValue(
    options.counts,
    "A cpd scan with a count needs --counts <file>.",
  );
  const text = await Deno.readTextFile(resolve(projectRoot, path)).catch(
    (error) => {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    },
  );
  return text === undefined ? undefined : readCounts(path, text);
};

/** Writes the current count, or returns the failure text for a check run. */
const outcome = async (): Promise<string | undefined> => {
  if (!options.update && !options.check) {
    console.error(yellow(worstLines.join("\n")));
    return;
  }
  const named = requireValue(
    options.counts,
    "A cpd scan with a count needs --counts <file>.",
  );
  const scan = requireValue(
    options.scan,
    "A cpd scan with a count needs --scan <name>.",
  );
  const counts = await rememberedCounts();
  const before = counts === undefined ? undefined : counts[scan];
  const count = placeCount(pairs);
  if (options.update) {
    if (before !== undefined && count > before) {
      throw new Error(
        `The ${scan} scan reports ${count} place(s), above the committed ` +
          `count ${before} in ${named}. Merge the duplicated code. ` +
          "Do not raise the count.",
      );
    }
    await writeJsonFile(
      resolve(projectRoot, named),
      updatedCounts(counts ?? {}, scan, count),
    );
    console.error(yellow(updateSummary(named, scan, count, before)));
    console.error(yellow(worstLines.join("\n")));
    return;
  }
  if (before === undefined) {
    throw new Error(
      counts === undefined
        ? `The cpd counts file ${named} does not exist. ` +
            "Run deno task cpd:update to write it."
        : `The cpd counts file ${named} holds no count for the ${scan} scan. ` +
            "Run deno task cpd:update to add it.",
    );
  }
  if (count <= before) {
    console.error(yellow(worstLines.join("\n")));
    return;
  }
  return [
    `${named}: the ${scan} scan reports ${count} place(s).`,
    `The committed count is ${before}.`,
    ...worstLines,
  ].join("\n");
};

const failure = await outcome();

if (failure !== undefined) {
  console.error(`
${bold(red("━━━ jscpd: the scan reports more duplicated places than its count ━━━"))}

${failure}`);
}

if (code !== 0 || failure !== undefined) {
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

  ${bold("3. jscpd:ignore is for static data, not code.")} The configs skip
     imports and re-exports, so those never need a marker. A declaration that
     holds only static data is data, not code. This covers a list of strings
     and an object hash whose values are literals. Wrap the whole declaration
     in /* jscpd:ignore-start -- static data, not code */ and
     /* jscpd:ignore-end */. Anywhere else an ignore tag is a code smell, not a
     fix.

  ${yellow("Never restructure the code just to break the token match")} (a
     config object, a rename, reordering) while two parallel implementations
     stay standing. That hides the signal and keeps the duplication. The
     question is "how do I make these two things one thing", not "how do I
     make jscpd stop flagging this".
`);
}

Deno.exit(code !== 0 ? code : failure !== undefined ? 1 : 0);
