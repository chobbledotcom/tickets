/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { minifyCss } from "./css-minify.ts";
import { buildStaticAssets } from "./build-static-assets.ts";

// Read deno.json import map (used by both client and edge builds)
const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));
const denoImports: Record<string, string> = denoConfig.imports;

// --- Step 1: Build client bundles ---
await buildStaticAssets();

// --- Step 2: Build edge bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining (client bundles freshly built above)
const rawCss = await Deno.readTextFile("./src/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const SVG = "image/svg+xml";

/** Asset definitions: [filename, exportName, contentType, pathConstant] */
const ASSET_DEFS: [string, string, string, string][] = [
  ["favicon.svg", "handleFavicon", SVG, ""],
  ["mvp.css", "handleMvpCss", CSS, "CSS_PATH"],
  ["admin.js", "handleAdminJs", JS, "JS_PATH"],
  ["scanner.js", "handleScannerJs", JS, "SCANNER_JS_PATH"],
  ["iframe-resizer-parent.js", "handleIframeResizerParentJs", JS, "IFRAME_RESIZER_PARENT_JS_PATH"],
  ["iframe-resizer-child.js", "handleIframeResizerChildJs", JS, "IFRAME_RESIZER_CHILD_JS_PATH"],
  ["embed.js", "handleEmbedJs", JS, "EMBED_JS_PATH"],
];

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": minifiedCss,
};

for (const [filename] of ASSET_DEFS) {
  if (filename === "favicon.svg" || filename === "mvp.css") continue;
  STATIC_ASSETS[filename] = await Deno.readTextFile(`./src/static/${filename}`);
}

// Packages to bundle directly (not externalize to CDN)
// These are used on every request and should not depend on CDN availability
const BUNDLED_PACKAGES = new Set(["@libsql/client"]);

// Edge subpath overrides (e.g., use web-compatible libsql client)
const EDGE_SUBPATHS: Record<string, string> = {
  "@libsql/client": "/web",
};

/** Map of bare specifiers to esm.sh CDN URLs, derived from deno.json imports */
const ESM_SH_EXTERNALS: Record<string, string> = {};

for (const [key, specifier] of Object.entries(denoImports)) {
  if (!specifier.startsWith("npm:")) continue;
  if (BUNDLED_PACKAGES.has(key)) continue;
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
    .map(([filename, , , pathConst]) => {
      // Embed script should always use latest version without cache-busting
      const cacheBuster = pathConst === "EMBED_JS_PATH" ? "" : `?ts=${BUILD_TS}`;
      return `export const ${pathConst} = "/${filename}${cacheBuster}";`;
    })
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

// --- Deno npm cache resolver for bundled packages ---

/** Discover Deno's npm cache path via `deno info --json` */
const getDenoNpmCache = (): string => {
  const result = new Deno.Command(Deno.execPath(), { args: ["info", "--json"], stdout: "piped" }).outputSync();
  const info = JSON.parse(new TextDecoder().decode(result.stdout));
  return `${info.npmCache}/registry.npmjs.org`;
};

const NPM_CACHE = getDenoNpmCache();

/** Condition priority for resolving package.json exports (matches platform: "browser") */
const CONDITIONS = ["browser", "import", "default"];

/** Resolve a package.json "exports" entry to a file path */
const resolveExport = (
  entry: string | Record<string, unknown>,
): string | null => {
  if (typeof entry === "string") return entry;
  for (const cond of CONDITIONS) {
    const val = entry[cond];
    if (val) return resolveExport(val as string | Record<string, unknown>);
  }
  return null;
};

/** Find a package in Deno's npm cache, returning its root directory */
const findPackageDir = (name: string): string | null => {
  const scopedDir = `${NPM_CACHE}/${name}`;
  try {
    // Find the installed version directory
    for (const entry of Deno.readDirSync(scopedDir)) {
      if (entry.isDirectory) return `${scopedDir}/${entry.name}`;
    }
  } catch { /* not found */ }
  return null;
};

/** Resolve a bare npm specifier (e.g. "@libsql/client" or "@libsql/core/api") */
const resolveNpmSpecifier = (specifier: string): string | null => {
  // Split into package name and subpath
  const parts = specifier.startsWith("@")
    ? specifier.split("/", 3)
    : specifier.split("/", 2);
  const pkgName = specifier.startsWith("@")
    ? `${parts[0]}/${parts[1]}`
    : parts[0]!;
  const subpath = specifier.startsWith("@")
    ? parts.slice(2).join("/")
    : parts.slice(1).join("/");

  const pkgDir = findPackageDir(pkgName);
  if (!pkgDir) return null;

  const pkgJson = JSON.parse(Deno.readTextFileSync(`${pkgDir}/package.json`));
  const exports = pkgJson.exports as Record<string, unknown> | undefined;
  if (exports) {
    const exportKey = subpath ? `./${subpath}` : ".";
    const entry = exports[exportKey] as string | Record<string, unknown> | undefined;
    if (entry) {
      const resolved = resolveExport(entry);
      if (resolved) return `${pkgDir}/${resolved}`;
    }
  }

  // Fallback: "browser" field (used by cross-fetch, etc.), then "module", then "main"
  if (!subpath) {
    const entry = (typeof pkgJson.browser === "string" && pkgJson.browser)
      || pkgJson.module
      || pkgJson.main;
    if (entry) return `${pkgDir}/${entry}`;
  }

  return null;
};

/**
 * Plugin to resolve bundled npm packages from Deno's npm cache.
 * Only handles packages listed in BUNDLED_PACKAGES and their transitive deps.
 */
const denoNpmResolverPlugin: Plugin = {
  name: "deno-npm-resolver",
  setup(build) {
    // Match bare specifiers (not relative paths, not URLs, not node: builtins)
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:")) return undefined;
      const resolved = resolveNpmSpecifier(args.path);
      if (resolved) return { path: resolved };
      return undefined;
    });
  },
};

// Externalize all Node.js built-in modules (per Bunny docs)
import { builtinModules } from "node:module";
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

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
  external: nodeExternals,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [esmShExternalsPlugin, denoNpmResolverPlugin, inlineAssetsPlugin],
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

// Bunny Edge Scripting has a 1MB script size limit
const BUNNY_MAX_SCRIPT_SIZE = 1_000_000;
if (content.length > BUNNY_MAX_SCRIPT_SIZE) {
  console.error(
    `Bundle size ${content.length} bytes exceeds Bunny's ${BUNNY_MAX_SCRIPT_SIZE} byte limit`,
  );
  Deno.exit(1);
}

await Deno.writeTextFile("./bunny-script.ts", content);

console.log(`Build complete: bunny-script.ts (${content.length} bytes)`);

// Clean up esbuild
esbuild.stop();

export {};
