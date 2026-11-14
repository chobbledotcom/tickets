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
 * Usage: deno run -A scripts/cpd.ts <jscpd args...>
 */

import { join } from "node:path";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import { ensureJscpd } from "./jscpd/install.ts";
import {
  describeWorstFamily,
  rankCloneFamilies,
  readClonePairs,
} from "./jscpd/worst.ts";
import { bold, red, yellow } from "./precommit/colors.ts";

// `--update` records the current clones into the committed baseline instead
// of checking for new ones, so translate it for jscpd and drop the check.
const args = Deno.args.includes("--update")
  ? [
      ...Deno.args.filter(
        (arg) => arg !== "--update" && arg !== "--fail-on-new-clones",
      ),
      "--update-baseline",
    ]
  : Deno.args;

/** The report that this scan writes, read from the config that `--config`
 * names. Every cpd task passes `--config`. jscpd writes `output` from the
 * working directory, so the report sits under the project root. */
const reportPath = async (): Promise<{ config: string; report: string }> => {
  const config = args[args.indexOf("--config") + 1];
  if (!args.includes("--config") || config === undefined) {
    throw new Error("scripts/cpd.ts needs --config <file>");
  }
  const { output } = v.parse(
    v.object({ output: v.string() }),
    JSON.parse(await Deno.readTextFile(config)),
  );
  return { config, report: join(projectRoot, output, "jscpd-report.json") };
};

const { config, report } = await reportPath();
// A crash before jscpd writes its report must not show the last run's report.
await Deno.remove(report).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

const { code } = await new Deno.Command(await ensureJscpd(), {
  args,
}).spawn().status;

const families = rankCloneFamilies(
  readClonePairs(JSON.parse(await Deno.readTextFile(report))),
);
console.error(
  yellow(describeWorstFamily(config, families, projectRoot).join("\n")),
);

if (code !== 0) {
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

Deno.exit(code);
