/**
 * IO shell for the comment checks: walks the source tree and reports what the
 * pure rules in `rules.ts` flag. Kept thin so the logic stays testable.
 */

import {
  byLine,
  type CheckOutput,
  reportCheck,
} from "#scripts/check-report.ts";
import { collectSourceFiles } from "#scripts/walk-files.ts";
import {
  type CommentLimits,
  findCommentIssues,
  findDeadLinks,
  formatIssue,
  namesMentioned,
} from "./rules.ts";

/**
 * Today's limits. Both numbers ratchet downward: lower one, bring the tree to
 * it, repeat. The number in this file is the whole mechanism, so no file ever
 * needs grandfathering. `docs/comment-policy.md` holds the schedule.
 */
export const LIMITS: CommentLimits = { maxColumns: 100, maxLines: 12 };

export const SOURCE_DIR = "src";

/**
 * Paths under the scanned root that no length limit applies to, as `deno doc`
 * renders the barrels' `@module` prose as our published API documentation, and
 * the static bundles are build output rather than authored source. The dead-link
 * check still covers them — a broken link in published docs is worse, not better.
 */
const EXEMPT = ["doc.ts", "docs/", "ui/static/"];

/**
 * A shipped, dated migration. These are append-only history that must never
 * change, so their prose is not ours to rewrite — the same reason `.jscpd.json`
 * ignores this glob. The live migration machinery beside them is not exempt.
 */
const isShippedMigration = (relative: string): boolean =>
  /(^|\/)migrations\/2\d{3}-/.test(`/${relative}`);

const isExempt = (relative: string): boolean =>
  isShippedMigration(relative) ||
  EXEMPT.some((entry) =>
    entry.endsWith("/") ? relative.startsWith(entry) : relative === entry,
  );

/**
 * The part of `path` below `root`. `collectSourceFiles` joins every path from
 * `root`, so the prefix is always there to drop.
 */
const relativeTo = (root: string, path: string): string =>
  path.slice(root.length + 1);

/**
 * Check every source file's comments. Logs a line per issue (or a success
 * line) and returns the process exit code: 0 when clean, 1 otherwise.
 */
export const runCommentCheck = async (
  root: string,
  limits: CommentLimits,
  output: CheckOutput,
): Promise<number> => {
  const files = await collectSourceFiles(root);
  const sources = await Promise.all(
    files.map(async (file) => ({
      content: await Deno.readTextFile(file),
      file,
    })),
  );
  // Which names exist is a whole-tree fact, so every file — exempt ones included
  // — is read before any link is judged.
  const known = new Set<string>();
  for (const { content } of sources) {
    for (const name of namesMentioned(content)) known.add(name);
  }
  const found: string[] = [];
  for (const { content, file } of sources) {
    const issues = [
      ...(isExempt(relativeTo(root, file))
        ? []
        : findCommentIssues(content, limits)),
      ...findDeadLinks(content, known),
    ].sort(byLine);
    for (const issue of issues) found.push(formatIssue(file, issue));
  }
  return reportCheck({
    ...output,
    found,
    guide: '"Comments are short" in AGENTS.md',
    noun: "comment",
    success: `Every comment in ${root} is at most ${limits.maxLines} lines and ${limits.maxColumns} columns, and every {@link} names something that exists.`,
  });
};
