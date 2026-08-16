/**
 * IO shell for the comment checks: walks the source tree and reports what the
 * pure rules in `rules.ts` flag. Kept thin so the logic stays testable.
 */

import { collectFiles } from "#scripts/walk-files.ts";
import { type CommentLimits, findCommentIssues, formatIssue } from "./rules.ts";

/**
 * Today's limits. Both numbers ratchet downward: lower one, bring the tree to
 * it, repeat. The number in this file is the whole mechanism, so no file ever
 * needs grandfathering. `docs/comment-policy.md` holds the schedule.
 */
export const LIMITS: CommentLimits = { maxColumns: 100, maxLines: 20 };

export const SOURCE_DIR = "src";

/**
 * Paths under the scanned root that no limit applies to, as `deno doc` renders
 * the barrels' `@module` prose as our published API documentation, and the
 * static bundles are build output rather than authored source.
 */
const EXEMPT = ["doc.ts", "docs/", "ui/static/"];

const isExempt = (relative: string): boolean =>
  EXEMPT.some((entry) =>
    entry.endsWith("/") ? relative.startsWith(entry) : relative === entry,
  );

/** The part of `path` below `root`, with no leading slash. */
const relativeTo = (root: string, path: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

/**
 * Check every source file's comments. Logs a line per issue (or a success
 * line) and returns the process exit code: 0 when clean, 1 otherwise.
 */
export const runCommentCheck = async (
  root: string,
  limits: CommentLimits,
  log: (line: string) => void,
  logError: (line: string) => void,
): Promise<number> => {
  const files = await collectFiles(
    root,
    (path) => /\.tsx?$/.test(path) && !isExempt(relativeTo(root, path)),
  );
  const found: string[] = [];
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    for (const issue of findCommentIssues(content, limits)) {
      found.push(formatIssue(file, issue));
    }
  }
  if (found.length === 0) {
    log(
      `Every comment in ${root} is at most ${limits.maxLines} lines and ${limits.maxColumns} columns.`,
    );
    return 0;
  }
  for (const line of found) logError(line);
  logError(
    `\n${found.length} comment issue(s) found. See "Comments are short" in AGENTS.md.`,
  );
  return 1;
};
