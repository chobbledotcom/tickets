/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { fromFileUrl } from "@std/path";
import { minifyCss } from "./css-minify.ts";

// Read deno.json import map (used by both client and edge builds)
const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));
const denoImports: Record<string, string> = denoConfig.imports;

// --- Step 1a: Build scanner.js (client bundle with jsQR) ---

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

// --- Step 1b: Build admin.js (client bundle with shared embed logic) ---

/** Resolve #-prefixed imports using the deno.json import map */
const projectRoot = fromFileUrl(new URL("..", import.meta.url));
const denoImportMapPlugin: Plugin = {
  name: "deno-import-map",
  setup(build) {
    build.onResolve({ filter: /^#/ }, (args) => {
      for (const [key, value] of Object.entries(denoImports)) {
        if (typeof value !== "string" || !value.startsWith("./")) continue;
        if (key.endsWith("/") && args.path.startsWith(key)) {
          return { path: projectRoot + value.slice(2) + args.path.slice(key.length) };
        }
        if (args.path === key) {
          return { path: projectRoot + value.slice(2) };
        }
      }
      return undefined;
    });
  },
};

const adminResult = await esbuild.build({
  entryPoints: ["./src/client/admin.ts"],
  outfile: "./src/static/admin.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  minify: true,
  plugins: [denoImportMapPlugin],
});

if (adminResult.errors.length > 0) {
  console.error("Admin build failed:");
  for (const log of adminResult.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

console.log("Admin build complete: src/static/admin.js");

// --- Step 1c: Build iframe-resizer-parent.js (client bundle) ---

/** Resolve @iframe-resizer/* and auto-console-group using Deno's import resolution */
const iframeResizerResolvePlugin: Plugin = {
  name: "iframe-resizer-resolve",
  setup(build) {
    build.onResolve({ filter: /^(@iframe-resizer\/|auto-console-group)/ }, (args) => ({
      path: fromFileUrl(import.meta.resolve(args.path)),
    }));
  },
};

const iframeResizerParentResult = await esbuild.build({
  entryPoints: ["./src/client/iframe-resizer-parent.ts"],
  outfile: "./src/static/iframe-resizer-parent.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  minify: true,
  plugins: [iframeResizerResolvePlugin],
});

if (iframeResizerParentResult.errors.length > 0) {
  console.error("iframe-resizer-parent build failed:");
  for (const log of iframeResizerParentResult.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

console.log("iframe-resizer-parent build complete: src/static/iframe-resizer-parent.js");

// --- Step 1d: Build iframe-resizer-child.js (client bundle) ---

const iframeResizerChildResult = await esbuild.build({
  entryPoints: ["./src/client/iframe-resizer-child.ts"],
  outfile: "./src/static/iframe-resizer-child.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  minify: true,
  banner: { js: "window.iframeResizer={license:'GPLv3'};" },
  plugins: [iframeResizerResolvePlugin],
});

if (iframeResizerChildResult.errors.length > 0) {
  console.error("iframe-resizer-child build failed:");
  for (const log of iframeResizerChildResult.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

console.log("iframe-resizer-child build complete: src/static/iframe-resizer-child.js");

// --- Step 2: Build edge bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining (client bundles freshly built above)
const rawCss = await Deno.readTextFile("./src/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": minifiedCss,
  "admin.js": await Deno.readTextFile("./src/static/admin.js"),
  "scanner.js": await Deno.readTextFile("./src/static/scanner.js"),
  "iframe-resizer-parent.js": await Deno.readTextFile("./src/static/iframe-resizer-parent.js"),
  "iframe-resizer-child.js": await Deno.readTextFile("./src/static/iframe-resizer-child.js"),
};

// Edge subpath overrides (e.g., use web-compatible libsql client)
const EDGE_SUBPATHS: Record<string, string> = {
  "@libsql/client": "/web",
};

/** Map of bare specifiers to esm.sh CDN URLs, derived from deno.json imports */
const ESM_SH_EXTERNALS: Record<string, string> = {};

for (const [key, specifier] of Object.entries(denoImports)) {
  if (!specifier.startsWith("npm:")) continue;
  const subpath = EDGE_SUBPATHS[key] ?? "";
  const url = `https://esm.sh/${specifier.slice(4)}${subpath}`;
  ESM_SH_EXTERNALS[key] = url;
  if (subpath) ESM_SH_EXTERNALS[`${key}${subpath}`] = url;
}

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
      contents: `export const CSS_PATH = "/mvp.css?ts=${BUILD_TS}";\nexport const JS_PATH = "/admin.js?ts=${BUILD_TS}";\nexport const SCANNER_JS_PATH = "/scanner.js?ts=${BUILD_TS}";\nexport const IFRAME_RESIZER_PARENT_JS_PATH = "/iframe-resizer-parent.js?ts=${BUILD_TS}";\nexport const IFRAME_RESIZER_CHILD_JS_PATH = "/iframe-resizer-child.js?ts=${BUILD_TS}";`,
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
        const iframeResizerParentJs = ${JSON.stringify(STATIC_ASSETS["iframe-resizer-parent.js"])};
        const iframeResizerChildJs = ${JSON.stringify(STATIC_ASSETS["iframe-resizer-child.js"])};

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

        export const handleIframeResizerParentJs = () =>
          new Response(iframeResizerParentJs, {
            headers: { "content-type": "application/javascript; charset=utf-8", ...CACHE_HEADERS },
          });

        export const handleIframeResizerChildJs = () =>
          new Response(iframeResizerChildJs, {
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
