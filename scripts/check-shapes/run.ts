/**
 * IO shell for the shape check: parses every source file, collects the named
 * function bodies, and reports the shape matches the accepted list does not
 * cover. Kept thin so the rules beside it stay testable.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import { acceptedProblems, formatProblem, parseAccepted } from "./accepted.ts";
import { namedFunctions } from "./functions.ts";
import { formatMatch, type ShapeSite, shapeMatches } from "./rules.ts";
import { shapeOf } from "./shape.ts";

/**
 * The shortest body that counts. This number ratchets downward: lower it,
 * bring the tree to it, repeat. Below about 20 tokens a body carries too
 * little shape for a match to mean anything.
 */
export const MIN_TOKENS = 20;

export const SOURCE_DIRS = ["src", "scripts"];

export const ACCEPTED_DIR = "scripts/check-shapes/accepted";

/**
 * Files whose repetition is not ours to remove, matching `.jscpd.json`:
 * `#fp`'s curried pairs are the shared mechanism itself, and a shipped
 * migration is history that must never change.
 */
const isExempt = (file: string): boolean =>
  /(^|\/)fp\.ts$/.test(file) ||
  /(^|\/)migrations\/2\d/.test(file) ||
  /(^|\/)migrations\/schema\/columns\.ts$/.test(file);

/** Every named function body under the given roots. */
export const collectSites = async (
  roots: readonly string[],
): Promise<ShapeSite[]> => {
  const sites: ShapeSite[] = [];
  for (const root of roots) {
    for (const file of await collectSourceFiles(root)) {
      if (isExempt(file)) continue;
      const source = await Deno.readTextFile(file);
      const { program } = parseSync(file, source);
      for (const found of namedFunctions(program, source)) {
        sites.push({
          body: source.slice(found.start, found.end),
          file,
          line: found.line,
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
  const matches = shapeMatches(await collectSites(roots), shapeOf, MIN_TOKENS);
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
