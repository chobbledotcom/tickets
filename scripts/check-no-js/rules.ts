// effects: pure
/**
 * The rule behind `deno task check:no-js`: this repository holds no
 * JavaScript source. Every authored file is TypeScript, so the type checker
 * and the lint rules read all of it.
 */

import { formatFinding } from "#scripts/check-report.ts";

const JAVASCRIPT_FILE = /\.[cm]?jsx?$/;

/** One finding line for each tracked path that is a JavaScript file. */
export const javascriptFindings = (paths: readonly string[]): string[] =>
  paths
    .filter((path) => JAVASCRIPT_FILE.test(path))
    .map((path) =>
      formatFinding(path, {
        fix: "write the file in TypeScript with the .ts or .tsx extension",
        problem: "JavaScript files are not supported",
        rule: "no-javascript",
      }),
    );
