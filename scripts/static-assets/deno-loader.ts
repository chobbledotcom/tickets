/** The esbuild plugins that resolve every bundle's imports through deno.json:
 * the `#` import map, npm/jsr specifiers, and each package's browser entry. */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { join } from "@std/path";
import type * as esbuild from "esbuild";
import { projectRoot } from "#scripts/project-root.ts";

const configPath = join(projectRoot, "deno.json");

/**
 * The loader ships its own esbuild type declarations, whose PluginBuild type can
 * drift from the npm esbuild package even though the runtime plugin shape is the
 * same. Keep that incompatibility at this adapter boundary.
 */
export const denoLoaderPlugins = (): esbuild.Plugin[] =>
  denoPlugins({ configPath }) as unknown as esbuild.Plugin[];
