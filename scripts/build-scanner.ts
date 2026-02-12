/**
 * Build script for scanner.js
 * Bundles the scanner client code with jsQR into a single IIFE for browser use.
 * Uses a plugin to resolve npm packages from Deno's cache.
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { fromFileUrl } from "@std/path";

/**
 * Plugin to resolve npm bare specifiers using Deno's import resolution.
 * Maps "jsqr" to the actual file path in Deno's npm cache.
 */
const denoNpmResolvePlugin: Plugin = {
  name: "deno-npm-resolve",
  setup(build) {
    build.onResolve({ filter: /^jsqr$/ }, () => {
      const resolved = import.meta.resolve("jsqr");
      return { path: fromFileUrl(resolved) };
    });
  },
};

const result = await esbuild.build({
  entryPoints: ["./src/client/scanner.js"],
  outfile: "./src/static/scanner.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  minify: true,
  plugins: [denoNpmResolvePlugin],
});

if (result.errors.length > 0) {
  console.error("Scanner build failed:");
  for (const log of result.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

console.log("Scanner build complete: src/static/scanner.js");

esbuild.stop();

export {};
