#!/usr/bin/env -S deno run --allow-all
/**
 * jscpd runner that prints actionable guidance when duplication is found.
 *
 * jscpd's own console report tells you *where* the duplication is, but not what
 * to do about it. This wrapper runs jscpd unchanged and forwards every arg, then
 * — only on a non-zero exit — appends a loud reminder of the project's
 * non-negotiable 0% policy: extract a helper, or curry, and reserve
 * `jscpd:ignore` for the one thing it is actually for (import blocks).
 *
 * Usage: deno run -A scripts/cpd.ts <jscpd args...>
 */

import { bold, red, yellow } from "./precommit/colors.ts";

const { code } = await new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "npm:jscpd", ...Deno.args],
}).spawn().status;

if (code !== 0) {
  console.error(`
${bold(red("━━━ jscpd: duplicated code found — the 0% threshold is non-negotiable ━━━"))}

Do NOT reach for ${bold("/* jscpd:ignore */")} to silence this. Fix the duplication:

  ${bold("1. Write a helper.")} This is the answer in ~99.999% of cases. If an
     obvious shared function jumps out, extract it and call it from both sites.

  ${bold("2. No obvious helper? Curry.")} Lift the parts that differ into
     arguments of a function that returns the specialised version, then call it
     at each site. ${yellow("Then review your work before committing")} — zoom out
     one step further. The first small curry you reach for is often not the
     best one; a larger, more holistic curry across the call sites is very
     frequently far better.

  ${bold("3. jscpd:ignore is the LAST resort.")} It is excusable for basically
     ${bold("one")} thing: ${bold("import blocks")} (plus the rare unavoidable scrap of
     boilerplate/infrastructure we have no control over). If the duplicated
     code is not an import block, you almost certainly want option 1 or 2 — an
     ignore tag anywhere else is a code smell, not a fix.
`);
}

Deno.exit(code);
