/**
 * Remembers what the browser assets were built from, so a build that would
 * produce byte-for-byte the same files can be skipped.
 *
 * Bundling the client code with esbuild and compiling the stylesheet with sass
 * costs about half a second, and the test harness does it before every run —
 * even `deno task test:files` on one small file, where it was most of the wall
 * clock. The client sources almost never change between two runs, so after a
 * build we write down every file that went into it (its size and modified
 * time) plus every file that came out. The next run compares that list against
 * the disk: if nothing moved, the assets on disk are already correct and the
 * build is skipped entirely — esbuild and sass are never even loaded.
 *
 * Size plus modified time, rather than a hash of the contents, keeps the check
 * to one `stat` per file. It errs towards rebuilding (a fresh checkout rewrites
 * modified times), never towards serving a stale asset.
 */

import { join } from "node:path";
import * as v from "valibot";
import { unique } from "#fp";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** How a file looked when the assets were last built. */
const TrackedFileSchema = v.object({
  mtime: v.number(),
  path: v.string(),
  size: v.number(),
});

export type TrackedFile = v.InferOutput<typeof TrackedFileSchema>;

/**
 * The record written after a successful build. `outputs` is listed separately
 * from `files` so a change to the *set* of bundles (one added or removed)
 * invalidates the cache even when every tracked file is untouched.
 */
const StaticAssetManifestSchema = v.object({
  files: v.array(TrackedFileSchema),
  outputs: v.array(v.string()),
});

export type StaticAssetManifest = v.InferOutput<
  typeof StaticAssetManifestSchema
>;

/** Where the record lives. Gitignored — it describes one working copy. */
export const STATIC_ASSET_MANIFEST_PATH = join(
  projectRoot,
  ".static-assets-cache.json",
);

/** How a file looks right now, or null when it is not there. */
export const trackFile = async (path: string): Promise<TrackedFile | null> => {
  try {
    const info = await Deno.stat(path);
    return { mtime: info.mtime?.getTime() ?? 0, path, size: info.size };
  } catch (error) {
    rethrowUnlessNotFound(error);
    return null;
  }
};

const sameFile = (
  recorded: TrackedFile,
  current: TrackedFile | null,
): boolean =>
  current !== null &&
  current.size === recorded.size &&
  current.mtime === recorded.mtime;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Can the assets on disk be trusted? Pure: `look` reports how each recorded
 * file looks now. True only when the bundles are the ones we build today and
 * every file the last build touched — inputs and outputs alike — is unchanged.
 */
export const manifestStillMatches = (
  manifest: StaticAssetManifest,
  outputs: readonly string[],
  look: (path: string) => TrackedFile | null,
): boolean =>
  sameList(manifest.outputs, outputs) &&
  manifest.files.every((recorded) => sameFile(recorded, look(recorded.path)));

/** Look every recorded file up on disk, keyed by path. */
export const lookUpTrackedFiles = async (
  manifest: StaticAssetManifest,
): Promise<Map<string, TrackedFile | null>> =>
  new Map(
    await Promise.all(
      manifest.files.map(
        async (recorded): Promise<[string, TrackedFile | null]> => [
          recorded.path,
          await trackFile(recorded.path),
        ],
      ),
    ),
  );

/** The last build's record, or null when there is none to trust. A record
 * written by an older or newer version of this file is simply ignored — the
 * assets get rebuilt, which is always safe. */
export const readStaticAssetManifest = async (
  path = STATIC_ASSET_MANIFEST_PATH,
): Promise<StaticAssetManifest | null> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    rethrowUnlessNotFound(error);
    return null;
  }
  const parsed = v.safeParse(StaticAssetManifestSchema, JSON.parse(text));
  return parsed.success ? parsed.output : null;
};

/** Record what this build was made from, so the next run can skip it. */
export const writeStaticAssetManifest = async (
  paths: readonly string[],
  outputs: readonly string[],
  path = STATIC_ASSET_MANIFEST_PATH,
): Promise<void> => {
  const files = await Promise.all(unique([...paths].sort()).map(trackFile));
  const manifest: StaticAssetManifest = {
    files: files.filter((file): file is TrackedFile => file !== null),
    outputs: [...outputs],
  };
  await Deno.writeTextFile(path, JSON.stringify(manifest));
};
