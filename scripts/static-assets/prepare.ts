/**
 * The test harness's one-line entry point to "make sure the browser assets are
 * ready", skipping the build when the files on disk were already made from
 * exactly these sources.
 *
 * The check is a handful of `stat` calls (see cache.ts). On a hit nothing else
 * happens at all: esbuild and sass are behind a dynamic import, so a repeat run
 * never loads them. On a miss the real build runs and records what it used.
 *
 * The result still offers the incremental rebuild the mutation runner needs. It
 * just waits until something asks: the first call to `affected`, `rebuild`, or
 * `restore` starts the real build, and a plain test run never makes one.
 *
 * The choice itself lives in `buildOrReuseStaticAssets`, where both arms are
 * unit tested. All that is left here is reading the real freshness answer and
 * handing on `quiet`.
 */

import { staticAssetsAreUpToDate } from "./cache.ts";
import { buildOrReuseStaticAssets, type StaticAssetBuild } from "./session.ts";

const loadBuild = (): Promise<
  typeof import("#scripts/build-static-assets.ts")
> => import("#scripts/build-static-assets.ts");

/**
 * The built browser assets a test run needs, built only if they are missing or
 * out of date.
 */
export const prepareStaticAssets = async (
  options: { quiet?: boolean } = {},
): Promise<StaticAssetBuild> =>
  buildOrReuseStaticAssets(await staticAssetsAreUpToDate(), async () =>
    (await loadBuild()).runStaticAssetBuild(options.quiet ?? false),
  );
