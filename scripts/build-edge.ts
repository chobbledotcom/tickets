/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import type { Plugin } from "esbuild";
import * as esbuild from "esbuild";
import { buildStaticAssets } from "./build-static-assets.ts";
import { isoToTag } from "./build-tag.ts";
import { minifyCss } from "./css-minify.ts";

// --- Step 1: Build client bundles ---
await buildStaticAssets();

// --- Step 2: Build edge bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

// Read static assets at build time for inlining (client bundles freshly built above)
const rawCss = await Deno.readTextFile("./src/ui/static/mvp.css");
const minifiedCss = await minifyCss(rawCss);

const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const SVG = "image/svg+xml";
const TEXT = "text/plain; charset=utf-8";

/** Asset definitions: [filename, exportName, contentType, pathConstant] */
const ASSET_DEFS: [string, string, string, string][] = [
  ["robots.txt", "handleRobotsTxt", TEXT, ""],
  ["favicon.svg", "handleFavicon", SVG, ""],
  ["mvp.css", "handleMvpCss", CSS, "CSS_PATH"],
  ["admin.js", "handleAdminJs", JS, "JS_PATH"],
  ["scanner.js", "handleScannerJs", JS, "SCANNER_JS_PATH"],
  [
    "iframe-resizer-parent.js",
    "handleIframeResizerParentJs",
    JS,
    "IFRAME_RESIZER_PARENT_JS_PATH",
  ],
  [
    "iframe-resizer-child.js",
    "handleIframeResizerChildJs",
    JS,
    "IFRAME_RESIZER_CHILD_JS_PATH",
  ],
  ["embed.js", "handleEmbedJs", JS, "EMBED_JS_PATH"],
];

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/ui/static/favicon.svg"),
  "mvp.css": minifiedCss,
};

for (const [filename] of ASSET_DEFS) {
  if (filename === "favicon.svg" || filename === "mvp.css") continue;
  STATIC_ASSETS[filename] = await Deno.readTextFile(
    `./src/ui/static/${filename}`,
  );
}

// Subpath overrides: use platform-specific entry points for certain packages
const EDGE_SUBPATHS: Record<string, string> = {
  "@bunny.net/edgescript-sdk": "/esm-bunny/lib.mjs",
  "@libsql/client": "/web",
};

/**
 * Build timestamp — always the current time. Used both as BUILD_TIMESTAMP
 * and (formatted) as the release tag in release builds, so the two always match.
 */
const BUILD_ISO = new Date().toISOString();

/** Build the inline build-info module with timestamp and commit SHA */
const buildBuildInfoModule = (): string => {
  const commit = Deno.env.get("BUILD_COMMIT") ?? "";
  return [
    `export const BUILD_TIMESTAMP = ${JSON.stringify(BUILD_ISO)};`,
    `export const BUILD_COMMIT = ${JSON.stringify(commit)};`,
  ].join("\n");
};

/** Build the inline asset-paths module with cache-busted paths */
const buildAssetPathsModule = (): string =>
  ASSET_DEFS.filter(([, , , pathConst]) => pathConst)
    .map(([filename, , , pathConst]) => {
      // Embed script should always use latest version without cache-busting
      const cacheBuster =
        pathConst === "EMBED_JS_PATH" ? "" : `?ts=${BUILD_TS}`;
      return `export const ${pathConst} = "/${filename}${cacheBuster}";`;
    })
    .join("\n");

/** Build the inline assets module with pre-read content and handler functions */
const buildAssetsModule = (): string => {
  const varLines = ASSET_DEFS.map(
    ([filename], i) =>
      `const v${i} = ${JSON.stringify(STATIC_ASSETS[filename])};`,
  );

  const cacheHeader = `const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, immutable" };`;

  const handlerLines = ASSET_DEFS.map(
    ([, exportName, contentType], i) =>
      `export const ${exportName} = () => new Response(v${i}, { headers: { "content-type": "${contentType}", ...CACHE_HEADERS } });`,
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
    // Replace build-info module with actual build metadata
    build.onResolve({ filter: /build-info\.ts$/ }, (args) => ({
      namespace: "inline-build-info",
      path: args.path,
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-build-info" }, () => ({
      contents: buildBuildInfoModule(),
      loader: "ts",
    }));

    // Replace asset paths module with cache-busted version
    build.onResolve({ filter: /asset-paths\.ts$/ }, (args) => ({
      namespace: "inline-asset-paths",
      path: args.path,
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-asset-paths" }, () => ({
      contents: buildAssetPathsModule(),
      loader: "ts",
    }));

    // Replace the assets module with inlined content
    build.onResolve(
      { filter: /(routes\/assets\.ts$|#routes\/assets\.ts$)/ },
      (args) => ({
        namespace: "inline-assets",
        path: args.path,
      }),
    );

    build.onLoad({ filter: /.*/, namespace: "inline-assets" }, () => ({
      contents: buildAssetsModule(),
      loader: "ts",
    }));
  },
};

// --- Deno npm cache resolver for bundled packages ---

/** Discover Deno's npm cache path via `deno info --json` */
const getDenoNpmCache = (): string => {
  const result = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).outputSync();
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
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Resolve a file path, trying .js/.json extensions and /index.js for extensionless CJS entries */
const resolveFile = (path: string): string =>
  [path, `${path}.js`, `${path}.json`, `${path}/index.js`].find(exists) ?? path;

/** Split a bare specifier into package name and subpath */
const parseSpecifier = (
  specifier: string,
): { pkgName: string; subpath: string } => {
  const nameSegments = specifier.startsWith("@") ? 2 : 1;
  const idx = specifier.split("/", nameSegments).join("/").length;
  return {
    pkgName: specifier.slice(0, idx === specifier.length ? undefined : idx),
    subpath: idx < specifier.length ? specifier.slice(idx + 1) : "",
  };
};

/** Try to resolve via the package.json exports map */
const resolveViaExports = (
  pkgDir: string,
  pkgJson: Record<string, unknown>,
  subpath: string,
): string | null => {
  if (!pkgJson.exports) return null;
  const key = subpath ? `./${subpath}` : ".";
  // Handle both subpath exports ({ ".": { ... } }) and top-level condition
  // exports ({ "browser": { ... }, "default": { ... } }) used by packages like stripe
  const exportEntry =
    pkgJson.exports[key] ??
    (!subpath && !("." in pkgJson.exports) ? pkgJson.exports : undefined);
  if (!exportEntry) return null;
  const resolved = resolveExport(exportEntry);
  return resolved ? resolveFile(`${pkgDir}/${resolved}`) : null;
};

/** Fallback resolution: browser → module → main → index.js */
const resolveViaFallback = (
  pkgDir: string,
  pkgJson: Record<string, unknown>,
): string => {
  if (typeof pkgJson.browser === "string") {
    return resolveFile(`${pkgDir}/${pkgJson.browser}`);
  }
  const entry = pkgJson.module ?? pkgJson.main;
  if (!entry) return resolveFile(`${pkgDir}/index`);
  // When browser is an object it's a module replacement map
  if (typeof pkgJson.browser === "object" && pkgJson.browser !== null) {
    const mapped = pkgJson.browser[entry];
    if (typeof mapped === "string") return resolveFile(`${pkgDir}/${mapped}`);
  }
  return resolveFile(`${pkgDir}/${entry}`);
};

/** Resolve a bare npm specifier (e.g. "@libsql/client" or "@libsql/core/api") */
const resolveNpmSpecifier = (specifier: string): string | null => {
  const { pkgName, subpath } = parseSpecifier(specifier);

  let pkgDir: string;
  try {
    pkgDir = findPackageDir(pkgName);
  } catch {
    return null;
  }

  const pkgJson = JSON.parse(Deno.readTextFileSync(`${pkgDir}/package.json`));

  const fromExports = resolveViaExports(pkgDir, pkgJson, subpath);
  if (fromExports) return fromExports;

  return subpath ? null : resolveViaFallback(pkgDir, pkgJson);
};

/** Plugin to resolve npm packages from Deno's npm cache */
const denoNpmResolverPlugin: Plugin = {
  name: "deno-npm-resolver",
  setup(build) {
    // Redirect packages that need platform-specific entry points
    for (const [pkg, subpath] of Object.entries(EDGE_SUBPATHS)) {
      const filter = new RegExp(
        `^${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      );
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

/**
 * Plugin to shim bare "crypto" imports with a Web Crypto API adapter.
 * node-forge's prng.js calls `require("crypto")` at module load time (before
 * `forge.options.usePureJavaScript` can be set) and uses `randomBytes()` for
 * seeding its Fortuna PRNG. We provide a shim that delegates to the Web Crypto
 * API (`globalThis.crypto.getRandomValues`), which is available in both Deno
 * and Bunny Edge runtimes. The node:-prefixed "node:crypto" stays external for
 * code that needs the full Node.js crypto API.
 */
const shimBareNodeCryptoPlugin: Plugin = {
  name: "shim-bare-node-crypto",
  setup(build) {
    build.onResolve({ filter: /^crypto$/ }, () => ({
      namespace: "shim-bare-crypto",
      path: "crypto",
    }));
    build.onLoad({ filter: /.*/, namespace: "shim-bare-crypto" }, () => ({
      contents: `
        export function randomBytes(size, cb) {
          var b = Buffer.alloc(size);
          globalThis.crypto.getRandomValues(b);
          if (cb) { cb(null, b); return; }
          return b;
        }
        export default { randomBytes };
      `,
      loader: "js",
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

await esbuild.build({
  banner: { js: NODEJS_GLOBALS_BANNER },
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  entryPoints: ["./src/edge.ts"],
  external: nodeExternals,
  format: "esm",
  minify: true,
  outdir: "./dist",
  platform: "browser",
  plugins: [
    shimBareNodeCryptoPlugin,
    denoNpmResolverPlugin,
    inlineAssetsPlugin,
  ],
});

// esbuild.build() throws on failure, so if we reach here the output file exists
const content = await Deno.readTextFile("./dist/edge.js");

// Bunny Edge Scripting has a 10MB script size limit
const BUNNY_MAX_SCRIPT_SIZE = 10_000_000;
if (content.length > BUNNY_MAX_SCRIPT_SIZE) {
  console.error(
    `Bundle size ${content.length} bytes exceeds Bunny's ${BUNNY_MAX_SCRIPT_SIZE} byte limit`,
  );
  Deno.exit(1);
}

await Deno.writeTextFile("./bunny-script.ts", content);

// Write the build tag so the release workflow can use it as the git tag.
// This ensures the release tag exactly matches the baked-in BUILD_TIMESTAMP.
await Deno.writeTextFile(".build-tag", isoToTag(BUILD_ISO));

console.log(`Build complete: bunny-script.ts (${content.length} bytes)`);

// Clean up esbuild
esbuild.stop();
