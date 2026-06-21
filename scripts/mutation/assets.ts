/**
 * Per-mutant static-asset rebuilding for the mutation runner (`--harness`).
 *
 * The test harness builds the client bundles in `src/ui/static/*.js` once, up
 * front. A mutant written to a TypeScript source that feeds one of those
 * bundles — e.g. `src/ui/client/admin.ts`, or anything it imports — would
 * otherwise never reach the built `.js` the tests load, so it would falsely
 * "survive". This rebuilds exactly the affected bundle(s) after each mutant is
 * applied, then restores the baseline build once the source is restored.
 *
 * The source → bundle map comes from esbuild's metafile, so it covers a mutated
 * *dependency* of an entry point, not just the entry itself. Bundles rebuild
 * with their real `STATIC_JS_BUNDLES` config, so the import-map (`#…`) and npm
 * resolution plugins still apply.
 */

import { resolve } from "@std/path";
import * as esbuild from "esbuild";
import {
  STATIC_JS_BUNDLES,
  type StaticBundle,
} from "../build-static-assets.ts";

export interface AssetRebuilder {
  /** Bundles whose dependency graph includes `file` (empty ⇒ no rebuild). */
  affected(file: string): StaticBundle[];
  /** Rebuild the given bundles in place; false if any failed to compile. */
  rebuild(bundles: StaticBundle[]): Promise<boolean>;
  /** Restore the given bundles' built output to the pre-mutation baseline. */
  restore(bundles: StaticBundle[]): Promise<void>;
  /** Shut the esbuild service down. */
  stop(): void;
}

const outfileOf = (bundle: StaticBundle): string =>
  resolve(Deno.cwd(), bundle.options.outfile as string);

/** Map every bundled input source file to the bundle(s) that include it. */
const buildGraph = async (): Promise<Map<string, StaticBundle[]>> => {
  const graph = new Map<string, StaticBundle[]>();
  for (const bundle of STATIC_JS_BUNDLES) {
    const result = await esbuild.build({
      ...bundle.options,
      metafile: true,
      write: false,
    });
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      const abs = resolve(Deno.cwd(), input);
      const bundles = graph.get(abs);
      if (bundles) bundles.push(bundle);
      else graph.set(abs, [bundle]);
    }
  }
  return graph;
};

/**
 * Build the source→bundle graph and snapshot the harness's baseline build, so a
 * mutant on a bundled source can rebuild the affected bundle(s) and then cheaply
 * restore the baseline bytes. Assumes the harness has already built the assets.
 */
export const createAssetRebuilder = async (): Promise<AssetRebuilder> => {
  const graph = await buildGraph();
  const baseline = new Map<string, Uint8Array>();
  for (const bundle of STATIC_JS_BUNDLES) {
    const outfile = outfileOf(bundle);
    baseline.set(outfile, await Deno.readFile(outfile));
  }

  return {
    affected: (file) => graph.get(resolve(Deno.cwd(), file)) ?? [],
    rebuild: async (bundles) => {
      for (const bundle of bundles) {
        const result = await esbuild.build(bundle.options);
        if (result.errors.length > 0) return false;
      }
      return true;
    },
    restore: async (bundles) => {
      for (const bundle of bundles) {
        const bytes = baseline.get(outfileOf(bundle));
        if (bytes) await Deno.writeFile(outfileOf(bundle), bytes);
      }
    },
    stop: () => esbuild.stop(),
  };
};
