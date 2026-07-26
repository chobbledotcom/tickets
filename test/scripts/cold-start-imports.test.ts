/**
 * Locks the cold-start module boundaries measured in docs/cold-start.md: the
 * heavy modules named here must not be statically reachable from the
 * production entry point. A static `import` of any of them would evaluate on
 * every fresh isolate, undoing the deferral that keeps cold starts fast.
 *
 * The check walks the real module graph (`deno info --json`), not source
 * text, so a refactor that preserves the boundary — moving a lazy import
 * behind another helper, renaming a symbol, splitting a file — keeps the
 * test green, while a genuine regression (re-adding a top-level static
 * import) fails it loudly.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  collectModuleGraphFiles,
  staticGraphFiles,
} from "#scripts/mutation/state-graph.ts";

const ENTRY = "src/serve-app.ts";

/**
 * Modules deferred behind dynamic imports to keep them off the cold-start
 * path. Each must appear in `deno info`'s full graph (so the deferral is
 * real, not just "absent") but must not be reachable through static imports
 * alone. If one shows up on the static graph, a static import crept back in
 * and every fresh isolate pays for it — move the import back behind
 * `await import(...)`.
 */
const DEFERRED_MODULES = [
  // Admin auth pulled into request handling only when `/api/admin/` matches.
  "src/features/auth.ts",
  // Schema migration code loaded only for database-backed requests.
  "src/shared/db/migrations.ts",
  // Broad public page + Markdown rendering kept off the error-page path.
  "src/ui/templates/public/shared.tsx",
  // Storage helpers split out so generic layouts do not pull them in.
  "src/shared/storage.ts",
];

const endsWith =
  (suffix: string) =>
  (path: string): boolean =>
    path.endsWith(suffix);

describe("cold-start import boundaries", () => {
  let staticFiles: Set<string>;
  let allFiles: Set<string>;

  const collectOnce = async (): Promise<void> => {
    if (!staticFiles) {
      [staticFiles, allFiles] = await Promise.all([
        staticGraphFiles(ENTRY, Deno.cwd()),
        collectModuleGraphFiles(ENTRY, Deno.cwd()),
      ]);
    }
  };

  for (const deferred of DEFERRED_MODULES) {
    test(`${deferred} is deferred, not statically imported by ${ENTRY}`, async () => {
      await collectOnce();
      // The module must be in the full graph at all — otherwise the deferral
      // is imaginary and the next assertion would pass for the wrong reason.
      const present = [...allFiles].filter(endsWith(deferred));
      expect(
        present.length,
        `${deferred} is not in the import graph of ${ENTRY} at all; ` +
          "the deferral is not real — add it back behind a dynamic import()",
      ).toBeGreaterThan(0);
      // And it must not be on the static path — that is the cold-start claim.
      const onStatic = [...staticFiles].filter(endsWith(deferred));
      expect(
        onStatic,
        `${deferred} is on the static import graph of ${ENTRY}; ` +
          "move it behind a dynamic import() so it does not evaluate on every cold start",
      ).toEqual([]);
    });
  }
});
