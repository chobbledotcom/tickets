#!/usr/bin/env -S deno run --allow-read=deno.json,src
/** Check the pure core against the effect table: every module the pure
 * list names must hold no import path — static or dynamic — to a module
 * that opens the database, the network, or the wall clock.
 *
 *     deno task check:effects
 *
 * A finding names the chain of imports that reaches the boundary, so the
 * fix is to split the IO shell out of the pure module, or to drop the
 * pure entry when the module genuinely became an IO shell. */

import { consoleOutput } from "#scripts/check-report.ts";
import { EFFECT_ROOTS, PURE_MODULES } from "./check-effects/effects.ts";
import { runEffectsCheck } from "./check-effects/run.ts";

Deno.exit(
  await runEffectsCheck({
    configPath: "deno.json",
    effects: EFFECT_ROOTS,
    output: consoleOutput,
    pureModules: PURE_MODULES,
    treeRoot: "src",
  }),
);
