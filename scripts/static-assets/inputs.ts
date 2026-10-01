/**
 * Which of the modules a bundle read are files on disk.
 *
 * Kept apart from the build itself so tests can read it without loading
 * esbuild and sass, as outfiles.ts does for the outputs.
 */

/** The deno loader fetches jsr dependencies from its cache and lists them in
 * the build metadata as URLs. A URL is not a file: resolving it would invent a
 * repo path that never exists, and a build record whose input is gone would
 * never be written at all (#2432). The lockfile, which every build tracks,
 * pins these modules' versions. */
const isFetchedModule = (key: string): boolean =>
  key.startsWith("https://") || key.startsWith("http://");

/** The build's inputs that are files on disk, from esbuild's module list. */
export const fileInputs = (moduleKeys: readonly string[]): string[] =>
  moduleKeys.filter((key) => !isFetchedModule(key));
