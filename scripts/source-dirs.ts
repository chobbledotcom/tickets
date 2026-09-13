/** The source trees every gate checker walks, in one list.
 *
 * Each checker's `deno.json` task must list the same roots in its
 * `--allow-read` permission, so a new root lands in both places at once. The
 * `.opencode` folder itself is not a root: its installed tooling does not
 * belong to this codebase, only the tracked plugin does. */
export const SOURCE_DIRS = [
  "src",
  "test",
  "scripts",
  "cli",
  "e2e-payments",
  ".opencode/plugins",
];
