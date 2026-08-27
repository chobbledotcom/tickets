/**
 * IO shell for the shape check: parses every source file, collects the named
 * function bodies, and reports the shape matches the accepted list does not
 * cover. Kept thin so the rules beside it stay testable.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { collectScriptFiles } from "#scripts/walk-files.ts";
import { acceptedProblems, formatProblem, parseAccepted } from "./accepted.ts";
import { jsxTextSpans, namedFunctions } from "./functions.ts";
import {
  formatMatch,
  outsideSharedMechanism,
  type ShapeSite,
  shapeMatches,
} from "./rules.ts";
import { maskJsxText, shapeOf } from "./shape.ts";

/**
 * The shortest body that counts. This number ratchets downward: lower it,
 * bring the tree to it, repeat. Below about 20 tokens a body carries too
 * little shape for a match to mean anything.
 */
export const MIN_TOKENS = 20;

/** The trees `.jscpd.json` scans, so a renamed copy cannot hide in one this
 * check never visits. */
export const SOURCE_DIRS = ["src", "scripts", "e2e-payments"];

export const ACCEPTED_DIR = "scripts/check-shapes/accepted";

/**
 * Files this check never reads, matching what `.jscpd.json` skips: a shipped
 * migration is history that must never change, and `src/ui/static` holds built
 * bundles rather than code anybody wrote.
 */
const isFrozen = (file: string): boolean =>
  /(^|\/)migrations\/2\d/.test(file) ||
  /(^|\/)migrations\/schema\/columns\.ts$/.test(file) ||
  /(^|\/)ui\/static\//.test(file);

/** The one file whose repetition is the point. See {@link outsideSharedMechanism}. */
export const isSharedMechanism = (file: string): boolean =>
  /(^|\/)fp\.ts$/.test(file);

/** Every named function body under the given roots. */
export const collectSites = async (
  roots: readonly string[],
): Promise<ShapeSite[]> => {
  const sites: ShapeSite[] = [];
  for (const root of roots) {
    for (const file of await collectScriptFiles(root)) {
      if (isFrozen(file)) continue;
      const source = await Deno.readTextFile(file);
      const { program } = parseSync(file, source);
      const jsxText = jsxTextSpans(program);
      for (const found of namedFunctions(program, source)) {
        sites.push({
          body: source.slice(found.start, found.end),
          file,
          line: found.line,
          masked: maskJsxText(source, found, jsxText),
          name: found.name,
        });
      }
    }
  }
  return sites;
};

/** Read every `.txt` in the accepted directory as one list. */
export const readAccepted = async (
  directory: string,
): Promise<ReturnType<typeof parseAccepted>> => {
  const entries = [];
  const malformed = [];
  for await (const file of Deno.readDir(directory)) {
    if (!file.name.endsWith(".txt")) continue;
    const parsed = parseAccepted(
      await Deno.readTextFile(`${directory}/${file.name}`),
    );
    entries.push(...parsed.entries);
    malformed.push(...parsed.malformed);
  }
  return { entries, malformed };
};

/**
 * Check every named function against every other. Logs a line per finding (or
 * a success line) and returns the process exit code: 0 when clean, 1 otherwise.
 */
export const runShapeCheck = async (
  roots: readonly string[],
  acceptedDir: string,
  output: CheckOutput,
): Promise<number> => {
  const matches = outsideSharedMechanism(isSharedMechanism)(
    shapeMatches(await collectSites(roots), shapeOf, MIN_TOKENS),
  );
  const { entries, malformed } = await readAccepted(acceptedDir);
  const accepted = new Set(entries.map((entry) => entry.key));
  const matchedKeys = new Set(matches.map((match) => match.key));
  const found = [
    ...matches
      .filter((match) => !accepted.has(match.key))
      .map((match) => formatMatch(match)),
    ...acceptedProblems(entries, malformed, matchedKeys).map(formatProblem),
  ];
  return reportCheck({
    ...output,
    found,
    guide: '"Code Duplication" in AGENTS.md',
    noun: "shape",
    success: `No two named functions in ${roots.join(", ")} share a shape of ${MIN_TOKENS}+ tokens, beyond the ${accepted.size} on the accepted list.`,
  });
};
