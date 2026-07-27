/**
 * One build of the browser assets at a time, across every process.
 *
 * Every writer goes through here: the test harness, `deno task build:static`,
 * and the edge build all write the same files in `src/ui/static/`. Two of them
 * running at once would build into each other, and the slower one could
 * overwrite the faster one's assets after it had already recorded them —
 * leaving a record that vouches for bundles it did not produce.
 *
 * The lock is held for the build *and* the recording that follows it, so a
 * record always describes the assets that are on disk when it is written.
 */

import { join } from "node:path";
import { withFileLock } from "#scripts/lock-file.ts";
import { projectRoot } from "#scripts/project-root.ts";

const BUILD_LOCK_PATH = join(projectRoot, ".static-assets-build.lock");

/** Run `body` with the browser-asset build to itself. */
export const withStaticAssetBuildLock = <T>(
  body: () => Promise<T>,
): Promise<T> => withFileLock(BUILD_LOCK_PATH, body);
