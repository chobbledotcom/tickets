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

/** What one finished build read, wrote, and started at. */
export interface CompletedStaticAssetBuild {
  /** Every file the bundler and stylesheet compiler read. */
  inputs: readonly string[];
  /** Every asset the build promised to leave on disk. */
  outputs: readonly string[];
  /** When the build began, as milliseconds since the epoch. */
  startedAt: number;
}

/** Inputs saved once the build was already reading, so we cannot tell whether
 * the assets were made from the old contents or the new ones. */
const changedDuringBuild = (
  files: readonly TrackedFile[],
  outputs: readonly string[],
  startedAt: number,
): TrackedFile[] => {
  const isOutput = new Set(outputs);
  return files.filter(
    (file) => !isOutput.has(file.path) && file.mtime >= startedAt,
  );
};

/**
 * Record what this build was made from, so the next run can skip it.
 *
 * Every asset the build promised to produce must be on disk: a record that
 * names an output it did not track would claim a cache hit for a file that is
 * not there, and the next run would skip the build and then fail reading it.
 * That is a broken build, so it throws.
 *
 * A source saved *while* the build was running is different — nothing is
 * broken, we simply cannot say which version of it the assets were made from.
 * Recording it would pin the new timestamp to possibly-old output and hide the
 * change from every later run. So no record is written at all, and the next run
 * rebuilds. Skipping the record is always safe; it only costs one build.
 *
 * The record is written under a name no other run will pick and renamed into
 * place, so neither an interrupted run nor a second runner racing this one can
 * leave half a record behind.
 */
export const writeStaticAssetManifest = async (
  build: CompletedStaticAssetBuild,
  path = STATIC_ASSET_MANIFEST_PATH,
): Promise<void> => {
  const paths = unique([...build.inputs, ...build.outputs].sort());
  const tracked = await Promise.all(paths.map(trackFile));
  const files = tracked.filter((file): file is TrackedFile => file !== null);
  const found = new Set(files.map((file) => file.path));
  const missing = build.outputs.filter((output) => !found.has(output));
  if (missing.length > 0) {
    throw new Error(
      `Static asset build did not leave every asset on disk: ${missing.join(", ")}`,
    );
  }
  const raced = changedDuringBuild(files, build.outputs, build.startedAt);
  if (raced.length > 0) return;
  const pending = `${path}.${crypto.randomUUID()}.pending`;
  await Deno.writeTextFile(
    pending,
    JSON.stringify({ files, outputs: build.outputs }),
  );
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
