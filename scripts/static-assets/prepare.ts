/**
 * Gets the browser assets ready for a test run, skipping the build when the
 * files on disk were already made from exactly these sources.
 *
 * The check is a handful of `stat` calls (see cache.ts). On a hit nothing else
 * happens at all: esbuild and sass are behind a dynamic import, so a repeat run
 * never loads them. On a miss the real build runs and records what it used.
 *
 * The result still offers the incremental rebuild the mutation runner needs. It
 * just waits until something asks: the first call to `affected`, `rebuild`, or
 * `restore` starts the real build, and a plain test run never makes one.
 */

import { once } from "#fp";
import {
  lookUpTrackedFiles,
  manifestStillMatches,
  readStaticAssetManifest,
} from "./cache.ts";
import { staticAssetOutputFiles } from "./outfiles.ts";
import type { StaticAssetBuild } from "./session.ts";

const loadBuild = (): Promise<typeof import("../build-static-assets.ts")> =>
  import("../build-static-assets.ts");

/** True when every file the last build read and wrote is still untouched. */
export const staticAssetsAreUpToDate = async (
  manifestPath?: string,
): Promise<boolean> => {
  const manifest = await readStaticAssetManifest(manifestPath);
  if (!manifest) return false;
  const current = await lookUpTrackedFiles(manifest);
  return manifestStillMatches(
    manifest,
    staticAssetOutputFiles(),
    (path) => current.get(path) ?? null,
  );
};

/**
 * A build that has not happened yet. Every method that genuinely needs esbuild
 * runs `build` first (once), so callers cannot tell the difference — they only
 * pay for it if they use it. Disposing a build nobody asked for does nothing.
 */
export const deferStaticAssetBuild = (
  build: () => Promise<StaticAssetBuild>,
): StaticAssetBuild => {
  const asked = { value: false };
  const started = once(async (): Promise<StaticAssetBuild> => {
    asked.value = true;
    return await build();
  });
  return {
    affected: async (file) => (await started()).affected(file),
    dispose: async () => {
      if (asked.value) await (await started()).dispose();
    },
    rebuild: async (bundles) => (await started()).rebuild(bundles),
    restore: async (bundles) => (await started()).restore(bundles),
  };
};

/**
 * The built browser assets a test run needs, built only if they are missing or
 * out of date.
 */
export const prepareStaticAssets = async (
  options: { quiet?: boolean } = {},
): Promise<StaticAssetBuild> => {
  const build = async (): Promise<StaticAssetBuild> =>
    await (await loadBuild()).runStaticAssetBuild(options.quiet ?? false);
  if (await staticAssetsAreUpToDate()) return deferStaticAssetBuild(build);
  return await build();
};
