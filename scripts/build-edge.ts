/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { minifyCss } from "./css-minify.ts";
import { buildStaticAssets } from "./build-static-assets.ts";

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

// Subpath overrides: use platform-specific entry points for certain packages
const EDGE_SUBPATHS: Record<string, string> = {
  "@libsql/client": "/web",
  "@bunny.net/edgescript-sdk": "/esm-bunny/lib.mjs",
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
const findPackageDir = (name: string): string => {
  const scopedDir = `${NPM_CACHE}/${name}`;
  for (const entry of Deno.readDirSync(scopedDir)) {
    if (entry.isDirectory) return `${scopedDir}/${entry.name}`;
  }
  throw new Error(`Package ${name} not found in npm cache`);
};

/** Check if a file exists */
const exists = (path: string): boolean => {
  try { Deno.statSync(path); return true; } catch { return false; }
};

/** Resolve a file path, trying .js/.json extensions and /index.js for extensionless CJS entries */
const resolveFile = (path: string): string =>
  [path, `${path}.js`, `${path}.json`, `${path}/index.js`].find(exists) ?? path;

/** Resolve a bare npm specifier (e.g. "@libsql/client" or "@libsql/core/api") */
const resolveNpmSpecifier = (specifier: string): string | null => {
  // Split into package name and subpath (scoped packages have 2 segments)
  const nameSegments = specifier.startsWith("@") ? 2 : 1;
  const idx = specifier.split("/", nameSegments).join("/").length;
  const pkgName = specifier.slice(0, idx === specifier.length ? undefined : idx);
  const subpath = idx < specifier.length ? specifier.slice(idx + 1) : "";

  let pkgDir: string;
  try { pkgDir = findPackageDir(pkgName); } catch { return null; }

  const pkgJson = JSON.parse(Deno.readTextFileSync(`${pkgDir}/package.json`));

  // Try exports map first
  const exportEntry = pkgJson.exports?.[subpath ? `./${subpath}` : "."];
  if (exportEntry) {
    const resolved = resolveExport(exportEntry);
    if (resolved) return resolveFile(`${pkgDir}/${resolved}`);
  }

  // Fallback: browser → module → main → index.js
  if (!subpath) {
    // browser field can be an object (module replacement map) — only use if string
    const entry = (typeof pkgJson.browser === "string" ? pkgJson.browser : null)
      ?? pkgJson.module ?? pkgJson.main;
    if (entry) return resolveFile(`${pkgDir}/${entry}`);
    return resolveFile(`${pkgDir}/index`);
  }

  return null;
};

/** Plugin to resolve npm packages from Deno's npm cache */
const denoNpmResolverPlugin: Plugin = {
  name: "deno-npm-resolver",
  setup(build) {
    // Redirect packages that need platform-specific entry points
    for (const [pkg, subpath] of Object.entries(EDGE_SUBPATHS)) {
      const filter = new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      build.onResolve({ filter }, () => {
        const resolved = resolveNpmSpecifier(`${pkg}${subpath}`);
        return resolved ? { path: resolved } : undefined;
      });
    }

    // Resolve all bare specifiers from Deno's npm cache
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:")) return undefined;
      const resolved = resolveNpmSpecifier(args.path);
      return resolved ? { path: resolved } : undefined;
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
// createRequire shim: npm packages bundled as CJS use require() for Node builtins
// (e.g. Stripe SDK does require("crypto")); esbuild's CJS compat shim checks
// typeof require, so a module-scoped `var require` makes it resolve correctly
const NODEJS_GLOBALS_BANNER = `import * as process from "node:process";
import { Buffer } from "node:buffer";
import { createRequire as __createRequire } from "node:module";
var require = __createRequire(import.meta.url);
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
`;

await esbuild.build({
  entryPoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  platform: "browser",
  format: "esm",
  minify: true,
  bundle: true,
  external: nodeExternals,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [denoNpmResolverPlugin, inlineAssetsPlugin],
  banner: { js: NODEJS_GLOBALS_BANNER },
});

// esbuild.build() throws on failure, so if we reach here the output file exists
const content = await Deno.readTextFile("./dist/bunny-script.js");

// Bunny Edge Scripting has a 10MB script size limit
const BUNNY_MAX_SCRIPT_SIZE = 10_000_000;
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
