/** Bundle the three.js renderer for the browser the same way the app bundles
 * its client code: esbuild plus the repository's Deno import map. */

import { join } from "@std/path";
import * as esbuild from "esbuild";
import { projectRoot } from "#scripts/project-root.ts";
import { denoLoaderPlugins } from "#scripts/static-assets/deno-loader.ts";

const ENTRY = join(projectRoot, "scripts", "guides", "renderer", "main.ts");

export const bundleGuideRenderer = async (): Promise<string> => {
  try {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [ENTRY],
      format: "esm",
      platform: "browser",
      plugins: denoLoaderPlugins(),
      target: "es2022",
      write: false,
    });
    const file = result.outputFiles?.[0];
    if (!file) throw new Error("esbuild produced no guide renderer bundle");
    return file.text;
  } finally {
    esbuild.stop();
  }
};
