/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { minifyCss } from "./css-minify.ts";

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining
const rawCss = await Deno.readTextFile("./src/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": minifiedCss,
};

/**
 * Plugin to inline static assets and handle Deno-specific imports
 * Replaces Deno.readTextFileSync calls with pre-read content
 */
const inlineAssetsPlugin: Plugin = {
  name: "inline-assets",
  setup(build) {
    // Replace asset paths module with cache-busted version
    build.onResolve({ filter: /config\/asset-paths\.ts$/ }, (args) => ({
      path: args.path,
      namespace: "inline-asset-paths",
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-asset-paths" }, () => ({
      contents: `export const CSS_PATH = "/mvp.css?ts=${BUILD_TS}";`,
      loader: "ts",
    }));

    // Replace the assets module with inlined content
    build.onResolve({ filter: /routes\/assets\.ts$/ }, (args) => ({
      path: args.path,
      namespace: "inline-assets",
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-assets" }, () => ({
      contents: `
        const faviconSvg = ${JSON.stringify(STATIC_ASSETS["favicon.svg"])};
        const mvpCss = ${JSON.stringify(STATIC_ASSETS["mvp.css"])};

        const CACHE_HEADERS = {
          "cache-control": "public, max-age=31536000, immutable",
        };

        export const handleMvpCss = () =>
          new Response(mvpCss, {
            headers: { "content-type": "text/css; charset=utf-8", ...CACHE_HEADERS },
          });

        export const handleFavicon = () =>
          new Response(faviconSvg, {
            headers: { "content-type": "image/svg+xml", ...CACHE_HEADERS },
          });
      `,
      loader: "ts",
    }));
  },
};

// Banner to inject Node.js globals that many packages expect (per Bunny docs)
// process.env is populated by Bunny's native secrets at runtime
const NODEJS_GLOBALS_BANNER = `import * as process from "node:process";
import { Buffer } from "node:buffer";
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
`;

const result = await esbuild.build({
  entryPoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  platform: "browser",
  format: "esm",
  minify: true,
  bundle: true,
  plugins: [inlineAssetsPlugin],
  external: [
    "@bunny.net/edgescript-sdk",
    "@libsql/client",
    "@libsql/client/web",
  ],
  banner: { js: NODEJS_GLOBALS_BANNER },
});

if (result.errors.length > 0) {
  console.error("Build failed:");
  for (const log of result.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

const outputPath = "./dist/bunny-script.js";
let content: string;
try {
  content = await Deno.readTextFile(outputPath);
} catch {
  console.error("No output file generated");
  Deno.exit(1);
}

// Rewrite package imports to esm.sh URLs for edge runtime
// Note: Both @libsql/client and @libsql/client/web get rewritten to the web version
const finalContent = content
  .replace(
    /from\s+["']@bunny\.net\/edgescript-sdk["']/g,
    'from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.0"',
  )
  .replace(
    /from\s+["']@libsql\/client\/web["']/g,
    'from "https://esm.sh/@libsql/client@0.6.0/web"',
  )
  .replace(
    /from\s+["']@libsql\/client["']/g,
    'from "https://esm.sh/@libsql/client@0.6.0/web"',
  );

await Deno.writeTextFile("./bunny-script.ts", finalContent);

console.log("Build complete: bunny-script.ts");

// Clean up esbuild
esbuild.stop();

export {};
