/**
 * CSS minification utility using esbuild
 */

import * as esbuild from "esbuild";

/**
 * Minify CSS using esbuild's transform API
 */
export async function minifyCss(css: string): Promise<string> {
  const result = await esbuild.transform(css, {
    loader: "css",
    minify: true,
  });
  return result.code;
}
