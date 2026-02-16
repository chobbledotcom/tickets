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

// --- Shared plugins ---

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

/** Resolve @iframe-resizer/* and auto-console-group using Deno's import resolution */
const iframeResizerResolvePlugin: Plugin = {
  name: "iframe-resizer-resolve",
  setup(build) {
    build.onResolve({ filter: /^(@iframe-resizer\/|auto-console-group)/ }, (args) => ({
      path: fromFileUrl(import.meta.resolve(args.path)),
    }));
  },
};

// --- Helper to build a client bundle and exit on failure ---

type ClientBuildOptions = {
  label: string;
  entryPoint: string;
  outfile: string;
  plugins?: Plugin[];
  banner?: Record<string, string>;
};

const buildClient = async ({ label, entryPoint, outfile, plugins = [], banner }: ClientBuildOptions) => {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
    plugins,
    banner,
  });

  if (result.errors.length > 0) {
    console.error(`${label} build failed:`);
    for (const log of result.errors) {
      console.error(log);
    }
    Deno.exit(1);
  }

  console.log(`${label} build complete: ${outfile}`);
};

// --- Step 1: Build client bundles ---

/** Resolve npm bare specifiers using Deno's import resolution */
const denoNpmResolvePlugin: Plugin = {
  name: "deno-npm-resolve",
  setup(build) {
    build.onResolve({ filter: /^jsqr$/ }, () => ({
      path: fromFileUrl(import.meta.resolve("jsqr")),
    }));
  },
};

await buildClient({
  label: "Scanner",
  entryPoint: "./src/client/scanner.js",
  outfile: "./src/static/scanner.js",
  plugins: [denoNpmResolvePlugin],
});

await buildClient({
  label: "Admin",
  entryPoint: "./src/client/admin.ts",
  outfile: "./src/static/admin.js",
  plugins: [denoImportMapPlugin],
});

await buildClient({
  label: "iframe-resizer-parent",
  entryPoint: "./src/client/iframe-resizer-parent.ts",
  outfile: "./src/static/iframe-resizer-parent.js",
  plugins: [iframeResizerResolvePlugin],
});

await buildClient({
  label: "iframe-resizer-child",
  entryPoint: "./src/client/iframe-resizer-child.ts",
  outfile: "./src/static/iframe-resizer-child.js",
  banner: { js: "window.iframeResizer={license:'GPLv3'};" },
  plugins: [iframeResizerResolvePlugin],
});

await buildClient({
  label: "Embed",
  entryPoint: "./src/client/embed.ts",
  outfile: "./src/static/embed.js",
  plugins: [iframeResizerResolvePlugin],
});

// --- Step 2: Build edge bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining (client bundles freshly built above)
const rawCss = await Deno.readTextFile("./src/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

/** Asset definitions: [filename, exportName, contentType, pathConstant] */
const ASSET_DEFS: [string, string, string, string][] = [
  ["favicon.svg", "handleFavicon", "image/svg+xml", ""],
  ["mvp.css", "handleMvpCss", "text/css; charset=utf-8", "CSS_PATH"],
  ["admin.js", "handleAdminJs", "application/javascript; charset=utf-8", "JS_PATH"],
  ["scanner.js", "handleScannerJs", "application/javascript; charset=utf-8", "SCANNER_JS_PATH"],
  ["iframe-resizer-parent.js", "handleIframeResizerParentJs", "application/javascript; charset=utf-8", "IFRAME_RESIZER_PARENT_JS_PATH"],
  ["iframe-resizer-child.js", "handleIframeResizerChildJs", "application/javascript; charset=utf-8", "IFRAME_RESIZER_CHILD_JS_PATH"],
  ["embed.js", "handleEmbedJs", "application/javascript; charset=utf-8", "EMBED_JS_PATH"],
];

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": minifiedCss,
};

for (const [filename] of ASSET_DEFS) {
  if (filename === "favicon.svg" || filename === "mvp.css") continue;
  STATIC_ASSETS[filename] = await Deno.readTextFile(`./src/static/${filename}`);
}

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

/** Build the inline asset-paths module with cache-busted paths */
const buildAssetPathsModule = (): string =>
  ASSET_DEFS
    .filter(([, , , pathConst]) => pathConst)
    .map(([filename, , , pathConst]) => `export const ${pathConst} = "/${filename}?ts=${BUILD_TS}";`)
    .join("\n");

/** Build the inline assets module with pre-read content and handler functions */
const buildAssetsModule = (): string => {
  const varLines = ASSET_DEFS
    .map(([filename], i) => `const v${i} = ${JSON.stringify(STATIC_ASSETS[filename])};`);

  const cacheHeader = `const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, immutable" };`;

  const handlerLines = ASSET_DEFS
    .map(([, exportName, contentType], i) =>
      `export const ${exportName} = () => new Response(v${i}, { headers: { "content-type": "${contentType}", ...CACHE_HEADERS } });`
    );

  return [...varLines, cacheHeader, ...handlerLines].join("\n");
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
      contents: buildAssetPathsModule(),
      loader: "ts",
    }));

    // Replace the assets module with inlined content
    build.onResolve({ filter: /routes\/assets\.ts$/ }, (args) => ({
      path: args.path,
      namespace: "inline-assets",
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-assets" }, () => ({
      contents: buildAssetsModule(),
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
