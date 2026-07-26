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
import { staticAssetOutputFiles } from "./outfiles.ts";

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

/** JSON that may have been left half-written, as data or as null. */
const parseOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // A torn record reads as "no record", so the next run rebuilds.
    return null;
  }
};

/** How a file looks right now, or null when it is not there. */
export const trackFile = async (path: string): Promise<TrackedFile | null> => {
  try {
    const info = await Deno.stat(path);
    // Number() of a Date is its timestamp, and of the null a platform without
    // modified times reports, 0 — so every platform gets one plain number.
    return { mtime: Number(info.mtime), path, size: info.size };
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

/** How each recorded file looks on disk now. A path the record never mentioned
 * answers null, the same as a file that has gone. */
export const lookUpTrackedFiles = async (
  manifest: StaticAssetManifest,
): Promise<(path: string) => TrackedFile | null> => {
  const current = new Map(
    await Promise.all(
      manifest.files.map(
        async (recorded): Promise<[string, TrackedFile | null]> => [
          recorded.path,
          await trackFile(recorded.path),
        ],
      ),
    ),
  );
  return (path) => current.get(path) ?? null;
};

/** The last build's record, or null when there is none to trust. A record we
 * cannot read — written by an older version of this file, or left half-written
 * by a run that was killed — is simply ignored. Rebuilding is always safe, and
 * it is the documented fallback here rather than a swallowed failure: a stale
 * cache file must never be able to stop the tests from running. */
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
  const parsed = v.safeParse(StaticAssetManifestSchema, parseOrNull(text));
  return parsed.success ? parsed.output : null;
};

/**
 * Record what this build was made from, so the next run can skip it.
 *
 * Every asset the build promised to produce must be on disk: a record that
 * names an output it did not track would claim a cache hit for a file that is
 * not there, and the next run would skip the build and then fail reading it.
 * The record is written to a temporary file and renamed into place, so a run
 * that is killed mid-write leaves the old record rather than half a new one.
 */
export const writeStaticAssetManifest = async (
  paths: readonly string[],
  outputs: readonly string[],
  path = STATIC_ASSET_MANIFEST_PATH,
): Promise<void> => {
  const tracked = await Promise.all(unique([...paths].sort()).map(trackFile));
  const files = tracked.filter((file): file is TrackedFile => file !== null);
  const found = new Set(files.map((file) => file.path));
  const missing = outputs.filter((output) => !found.has(output));
  if (missing.length > 0) {
    throw new Error(
      `Static asset build did not leave every asset on disk: ${missing.join(", ")}`,
    );
  }
  const pending = `${path}.pending`;
  await Deno.writeTextFile(pending, JSON.stringify({ files, outputs }));
  await Deno.rename(pending, path);
};

/** True when every file the last build read and wrote is still untouched, so
 * the assets on disk are exactly what a fresh build would produce. */
export const staticAssetsAreUpToDate = async (
  path?: string,
): Promise<boolean> => {
  const manifest = await readStaticAssetManifest(path);
  if (!manifest) return false;
  return manifestStillMatches(
    manifest,
    staticAssetOutputFiles(),
    await lookUpTrackedFiles(manifest),
  );
};
