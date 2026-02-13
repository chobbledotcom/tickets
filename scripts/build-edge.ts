/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { fromFileUrl } from "@std/path";
import { minifyCss } from "./css-minify.ts";

// --- Step 1: Build scanner.js (client bundle with jsQR) ---

/** Resolve npm bare specifiers using Deno's import resolution */
const denoNpmResolvePlugin: Plugin = {
  name: "deno-npm-resolve",
  setup(build) {
    build.onResolve({ filter: /^jsqr$/ }, () => ({
      path: fromFileUrl(import.meta.resolve("jsqr")),
    }));
  },
};

const scannerResult = await esbuild.build({
  entryPoints: ["./src/client/scanner.js"],
  outfile: "./src/static/scanner.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  minify: true,
  plugins: [denoNpmResolvePlugin],
});

if (scannerResult.errors.length > 0) {
  console.error("Scanner build failed:");
  for (const log of scannerResult.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

console.log("Scanner build complete: src/static/scanner.js");

// --- Step 2: Build edge bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining (scanner.js now freshly built above)
const rawCss = await Deno.readTextFile("./src/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": minifiedCss,
  "admin.js": await Deno.readTextFile("./src/static/admin.js"),
  "scanner.js": await Deno.readTextFile("./src/static/scanner.js"),
};

/** Map of bare specifiers to esm.sh CDN URLs for edge runtime */
const ESM_SH_EXTERNALS: Record<string, string> = {
  "@bunny.net/edgescript-sdk":
    "https://esm.sh/@bunny.net/edgescript-sdk@0.11.0",
  "@libsql/client/web": "https://esm.sh/@libsql/client@0.6.0/web",
  "@libsql/client": "https://esm.sh/@libsql/client@0.6.0/web",
  "qrcode": "https://esm.sh/qrcode@1.5.0",
  "stripe": "https://esm.sh/stripe@17.0.0",
  "square": "https://esm.sh/square@43.0.0",
};

/** Rewrite bare package imports to esm.sh URLs and mark them external */
const esmShExternalsPlugin: Plugin = {
  name: "esm-sh-externals",
  setup(build) {
    const filter = new RegExp(
      "^(" +
        Object.keys(ESM_SH_EXTERNALS)
          .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|") +
        ")$",
    );
    build.onResolve({ filter }, (args) => ({
      path: ESM_SH_EXTERNALS[args.path]!,
      external: true,
    }));
  },
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
      contents: `export const CSS_PATH = "/mvp.css?ts=${BUILD_TS}";\nexport const JS_PATH = "/admin.js?ts=${BUILD_TS}";\nexport const SCANNER_JS_PATH = "/scanner.js?ts=${BUILD_TS}";`,
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
        const adminJs = ${JSON.stringify(STATIC_ASSETS["admin.js"])};
        const scannerJs = ${JSON.stringify(STATIC_ASSETS["scanner.js"])};

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

        export const handleAdminJs = () =>
          new Response(adminJs, {
            headers: { "content-type": "application/javascript; charset=utf-8", ...CACHE_HEADERS },
          });

        export const handleScannerJs = () =>
          new Response(scannerJs, {
            headers: { "content-type": "application/javascript; charset=utf-8", ...CACHE_HEADERS },
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
  plugins: [esmShExternalsPlugin, inlineAssetsPlugin],
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

await Deno.writeTextFile("./bunny-script.ts", content);

console.log("Build complete: bunny-script.ts");

// Clean up esbuild
esbuild.stop();

export {};
