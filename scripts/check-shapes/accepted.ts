/**
 * The accepted list: the shape matches this tree already carries, each with a
 * note saying why it stands. The list only shrinks. A match that is not on it
 * fails the check, and an entry that no longer matches anything fails too, so
 * a merge has to take its entry with it — and so does an edit to a listed
 * body, which changes its fingerprint and stales the entry until somebody
 * re-reads the note.
 */

import { entryLines } from "#scripts/registry-lines.ts";

/** One line of the list: the match it names, and why it stands. */
export interface AcceptedEntry {
  key: string;
  note: string;
}

/** Everything wrong with the list, said the way a reader can act on. */
export interface AcceptedProblem {
  detail: string;
  kind: "duplicate" | "malformed" | "stale";
}

/**
 * Read one file of the list. A line is a key, two spaces, a `#`, and the note.
 */
export const parseAccepted = (
  text: string,
): { entries: AcceptedEntry[]; malformed: string[] } => {
  const entries: AcceptedEntry[] = [];
  const malformed: string[] = [];
  for (const line of entryLines(text)) {
    const split = line.indexOf("#");
    const key = split === -1 ? line.trim() : line.slice(0, split).trim();
    const note = split === -1 ? "" : line.slice(split + 1).trim();
    if (key === "" || note === "") malformed.push(line.trim());
    else entries.push({ key, note });
  }
  return { entries, malformed };
};

/**
 * What the list gets wrong about the tree it describes: a key written twice,
 * a line missing its key or its note, and an entry nothing matches any more.
 */
export const acceptedProblems = (
  entries: readonly AcceptedEntry[],
  malformed: readonly string[],
  matchedKeys: ReadonlySet<string>,
): AcceptedProblem[] => {
  const problems: AcceptedProblem[] = malformed.map((line) => ({
    detail: `${line} — write the match, two spaces, then "# why it stands"`,
    kind: "malformed" as const,
  }));
  const seen = new Set<string>();
  for (const entry of entries) {
    const kind = seen.has(entry.key)
      ? "duplicate"
      : matchedKeys.has(entry.key)
        ? null
        : "stale";
    seen.add(entry.key);
    if (kind !== null) problems.push({ detail: entry.key, kind });
  }
  return problems;
};

/** One problem, ready to print. */
export const formatProblem = (problem: AcceptedProblem): string => {
  const reason = {
    duplicate: "listed twice",
    malformed: "cannot be read",
    stale:
      "matches nothing now — re-read its note, then refresh its fingerprints, or delete it",
  }[problem.kind];
  return `${reason}: ${problem.detail}`;
};
