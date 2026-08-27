/**
 * IO shell for the shape check: parses every source file, collects the named
 * function bodies, and reports the shape matches the accepted list does not
 * cover. Kept thin so the rules beside it stay testable.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { collectScriptFiles } from "#scripts/walk-files.ts";
import { acceptedProblems, formatProblem, parseAccepted } from "./accepted.ts";
import { maskedRuns, namedFunctions } from "./functions.ts";
import {
  formatMatch,
  outsideSharedMechanism,
  type ShapeSite,
  shapeMatches,
} from "./rules.ts";
import { maskSpans, shapeOf } from "./shape.ts";

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

/**
 * The names one file's functions go by, with `@1`, `@2` in source order where
 * two of them share a name. A key has to name one function, and even a fully
 * qualified name repeats — two callbacks in one object's entries, say.
 */
const distinctNames = (found: readonly { name: string }[]): string[] => {
  const sharing = Map.groupBy(found, (one) => one.name);
  const seen = new Map<string, number>();
  return found.map((one) => {
    if ((sharing.get(one.name) as unknown[]).length === 1) return one.name;
    const nth = (seen.get(one.name) ?? 0) + 1;
    seen.set(one.name, nth);
    return `${one.name}@${nth}`;
  });
};

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
      const runs = maskedRuns(program, source);
      const found = namedFunctions(program, source);
      const names = distinctNames(found);
      found.forEach((one, index) => {
        sites.push({
          body: source.slice(one.start, one.end),
          file,
          line: one.line,
          masked: maskSpans(source, one, runs),
          name: names[index] as string,
          sharedMechanism: isSharedMechanism(file),
        });
      });
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
  const matches = outsideSharedMechanism(
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
