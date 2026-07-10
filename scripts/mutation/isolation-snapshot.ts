/**
 * Snapshot copying for isolated mutation runs.
 *
 * Decides which paths belong in the copied checkout and performs the recursive
 * copy. Kept separate from the record/lock state so the pure filtering rules
 * are cheap to unit-test directly.
 */

import { dirname, join } from "@std/path";

const SKIPPED_TOP_LEVEL_NAMES = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".deno",
  ".deno-cache",
  ".deno_cache",
  ".direnv",
  ".do",
  ".git",
  ".i18n-work",
  ".local-data",
  ".mutation-runs",
  ".pi-worktrees",
  "cov",
  "cov_profile",
  "dist",
  "docs-output",
  "misc",
  "node_modules",
  "undefined",
  "null",
]);

const SKIPPED_TOP_LEVEL_PREFIXES = ["coverage", ".jscpd", "docs-output"];

const SKIPPED_FILE_NAMES = new Set([
  ".build-tag",
  ".db-key",
  ".env",
  ".test-junit.xml",
  "bunny-script.ts",
  "bunny-script.ts.map",
  "tickets.db",
]);

const pathParts = (path: string): string[] =>
  path.split(/[\\/]+/).filter((part) => part.length > 0);

const slashPath = (path: string): string => pathParts(path).join("/");

const isDatabaseFile = (name: string): boolean =>
  name.endsWith(".db") || name.endsWith(".db-shm") || name.endsWith(".db-wal");

const isGeneratedStaticAsset = (relativePath: string): boolean =>
  relativePath.startsWith("src/ui/static/") &&
  (relativePath.endsWith(".js") || relativePath === "src/ui/static/style.css");

export const shouldCopySnapshotPath = (relativePath: string): boolean => {
  const parts = pathParts(relativePath);
  const top = parts[0];
  const name = parts.at(-1);
  if (!top || !name) return true;
  if (SKIPPED_TOP_LEVEL_NAMES.has(top)) return false;
  if (SKIPPED_TOP_LEVEL_PREFIXES.some((prefix) => top.startsWith(prefix))) {
    return false;
  }
  if (SKIPPED_FILE_NAMES.has(name) || isDatabaseFile(name)) return false;
  return !isGeneratedStaticAsset(slashPath(relativePath));
};

const copyDirectory = async (
  fromRoot: string,
  toRoot: string,
  relativePath = "",
): Promise<void> => {
  const fromDir = join(fromRoot, relativePath);
  const toDir = join(toRoot, relativePath);
  await Deno.mkdir(toDir, { recursive: true });

  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(fromDir)) entries.push(entry);

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childPath = relativePath
      ? join(relativePath, entry.name)
      : entry.name;
    if (!shouldCopySnapshotPath(childPath)) continue;

    const from = join(fromRoot, childPath);
    const to = join(toRoot, childPath);
    if (entry.isDirectory) {
      await copyDirectory(fromRoot, toRoot, childPath);
    } else {
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(from, to);
    }
  }
};

export const copyMutationSnapshot = async (
  fromRoot: string,
  toRoot: string,
): Promise<void> => {
  await Deno.mkdir(toRoot, { recursive: true });
  await copyDirectory(fromRoot, toRoot);
};
