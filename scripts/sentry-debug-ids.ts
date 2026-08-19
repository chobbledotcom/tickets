/**
 * Give the deployed bundle a Sentry debug id.
 *
 * `sentry-cli sourcemaps inject` writes debug ids only into files it recognises
 * as JavaScript. For anything else it prints "Nothing to inject" and exits 0.
 * Our deployed bundle is `bunny-script.ts`, so it never received one: events
 * arrived with no `debug_meta`, every uploaded source map went unmatched, and
 * production stack traces stayed minified.
 *
 * These commands wrap the CLI. `prepare` writes a JavaScript copy for the CLI
 * to inject. `adopt` copies the injected code back onto the deployed bundle, so
 * the bundle we deploy and the map we upload carry the same debug id.
 * `js-path` names that copy, for the upload step to send.
 *
 * Every command prints the JavaScript path, so a caller never has to rebuild
 * the name itself.
 */

import { basename } from "@std/path";

import { renameSourceMapLink } from "./edge-bundle-modules.ts";

/** The JavaScript name the Sentry CLI accepts for a given bundle. */
export const jsSiblingPath = (bundlePath: string): string =>
  `${bundlePath.replace(/\.[jt]s$/, "")}.js`;

/** A bundle and its map always travel together, under matching names. */
const mapOf = (path: string): string => `${path}.map`;

/**
 * Copy `from` to `to`, re-pointing the map link at the destination's own map.
 * The map is copied as it is; the Sentry CLI rewrites it in place.
 *
 * The link names a file beside the bundle, never a path, so the rename works
 * on the file names alone. Pairing the bundle with its map is how the CLI
 * finds the map to write a debug id into.
 */
const copyBundle = async (from: string, to: string): Promise<void> => {
  const code = await Deno.readTextFile(from);
  await Deno.writeTextFile(
    to,
    renameSourceMapLink(code, basename(mapOf(from)), basename(mapOf(to))),
  );
  await Deno.copyFile(mapOf(from), mapOf(to));
};

/** What each command does to the bundle before its path is printed. */
const COMMANDS: Record<string, (bundlePath: string) => Promise<void>> = {
  /** Copy the injected code and map back onto the bundle we deploy. */
  adopt: (bundlePath) => copyBundle(jsSiblingPath(bundlePath), bundlePath),
  /** Name the JavaScript copy without touching any file. */
  "js-path": () => Promise.resolve(),
  /** Write the JavaScript copy the Sentry CLI will inject debug ids into. */
  prepare: (bundlePath) => copyBundle(bundlePath, jsSiblingPath(bundlePath)),
};

/** Run one named command, and return the JavaScript path it worked on. */
export const runCommand = async (
  command: string,
  bundlePath: string,
): Promise<string> => {
  const run = COMMANDS[command];
  if (!run) {
    throw new Error(
      `Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(
        ", ",
      )}.`,
    );
  }
  await run(bundlePath);
  return jsSiblingPath(bundlePath);
};

if (import.meta.main) {
  const [command, bundlePath] = Deno.args;
  if (!command || !bundlePath) {
    console.error(
      `Usage: sentry-debug-ids.ts <${Object.keys(COMMANDS).join(
        "|",
      )}> <bundle-path>`,
    );
    Deno.exit(1);
  }
  console.log(await runCommand(command, bundlePath));
}
