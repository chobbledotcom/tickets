/** The source trees the whole-tree code gates walk, in one list.
 *
 * A gate that walks every code tree reads this list, and a gate that must
 * leave one tree out derives its list from this one, so a new root lands in
 * every gate at once. Each gate's `deno.json` task must list the same roots
 * in its `--allow-read` permission, so the root lands in both places. The
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
