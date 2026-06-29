/**
 * Build script for Deno Deploy.
 *
 * Produces a single self-contained ESM bundle (`dist/deploy.js`) that Deno
 * Deploy serves directly, so the deployed artifact is a few MB rather than the
 * ~78MB dependency graph Deploy would resolve from source (the native
 * `@libsql/client` binding plus the Stripe/SumUp/Sentry SDKs), whose artifact
 * upload exceeds Deploy's limit.
 *
 * The bundling mirrors `scripts/build-edge.ts` (same asset inlining, Node-global
 * banner, crypto shim, and `platform: "browser"` — which resolves
 * `@libsql/client` to its pure-JS `web` export). The only differences are the
 * entry point (`src/deploy.ts`, a `Deno.serve` wrapper) and the output path;
 * there is no Bunny 10MB script-size ceiling and no release-tag emission. The
 * two scripts are kept separate so a change to the production Bunny build can
 * never accidentally alter the Deno Deploy build, or vice versa.
 */

import { builtinModules } from "node:module";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl } from "@std/path";
import type { Plugin } from "esbuild";
import * as esbuild from "esbuild";
import { buildStaticAssets } from "./build-static-assets.ts";
import { minifyCss } from "./css-minify.ts";

// --- Step 1: Build client bundles ---
await buildStaticAssets();

// --- Step 2: Build deploy bundle ---

// Build timestamp for cache-busting (seconds since epoch)
const BUILD_TS = Math.floor(Date.now() / 1000);

const rawCss = await Deno.readTextFile("./src/ui/static/style.css");
const minifiedCss = await minifyCss(rawCss);

const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const SVG = "image/svg+xml";
const TEXT = "text/plain; charset=utf-8";

/** Asset definitions: [filename, exportName, contentType, pathConstant] */
const ASSET_DEFS: [string, string, string, string][] = [
  ["robots.txt", "handleRobotsTxt", TEXT, ""],
  ["favicon.svg", "handleFavicon", SVG, ""],
  ["icons.svg", "handleIcons", SVG, "ICONS_PATH"],
  ["style.css", "handleStyleCss", CSS, "CSS_PATH"],
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
  ["contact.js", "handleContactJs", JS, "CONTACT_JS_PATH"],
];

const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/ui/static/favicon.svg"),
  "style.css": minifiedCss,
};

for (const [filename] of ASSET_DEFS) {
  if (filename === "favicon.svg" || filename === "style.css") continue;
  STATIC_ASSETS[filename] = await Deno.readTextFile(
    `./src/ui/static/${filename}`,
  );
}

// The external-order widget is served by a dynamic route (not an ASSET_DEFS
// handler), but its body must still be inlined for the bundled runtime, which
// has no filesystem. Read it here so buildAssetsModule() can bake it in.
STATIC_ASSETS["order.js"] = await Deno.readTextFile("./src/ui/static/order.js");

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

  const orderWidget = [
    `const orderJsBody = ${JSON.stringify(STATIC_ASSETS["order.js"])};`,
    "export const orderWidgetBody = () => orderJsBody;",
  ].join("\n");

  return [...varLines, cacheHeader, ...handlerLines, orderWidget].join("\n");
};

/** Plugin to inline static assets and build metadata (no filesystem at runtime) */
const inlineAssetsPlugin: Plugin = {
  name: "inline-assets",
  setup(build) {
    build.onResolve({ filter: /build-info\.ts$/ }, (args) => ({
      namespace: "inline-build-info",
      path: args.path,
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-build-info" }, () => ({
      contents: buildBuildInfoModule(),
      loader: "ts",
    }));

    build.onResolve({ filter: /asset-paths\.ts$/ }, (args) => ({
      namespace: "inline-asset-paths",
      path: args.path,
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-asset-paths" }, () => ({
      contents: buildAssetPathsModule(),
      loader: "ts",
    }));

    build.onResolve(
      { filter: /(features\/assets\.ts$|#routes\/assets\.ts$)/ },
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

// Externalize Node.js built-in modules; Deno Deploy provides them natively.
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

/**
 * Shim bare "crypto" imports with a Web Crypto adapter. node-forge's prng.js
 * calls `require("crypto")` at module load for `randomBytes()` seeding; delegate
 * to `globalThis.crypto.getRandomValues`, available in Deno. "node:crypto" stays
 * external for code needing the full Node crypto API.
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

// Inject Node globals many packages expect; process.env is populated by Deno
// Deploy's environment at runtime (getEnv also falls back to Deno.env).
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
  entryPoints: ["./src/deploy.ts"],
  external: nodeExternals,
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "#jsx",
  minify: true,
  outdir: "./dist",
  platform: "browser",
  plugins: [
    shimBareNodeCryptoPlugin,
    inlineAssetsPlugin,
    ...denoPlugins({
      configPath: fromFileUrl(new URL("../deno.json", import.meta.url)),
    }),
  ],
  sourcemap: true,
});

// esbuild.build() throws on failure, so reaching here means dist/deploy.js exists.
const content = await Deno.readTextFile("./dist/deploy.js");

// Guard: the app renders with a custom JSX runtime (#jsx), never React. If
// esbuild ever falls back to the classic transform the bundle references an
// undefined `React` and every page 500s at runtime. Tests don't catch this
// (they run TSX under Deno), so assert on the built bundle.
if (content.includes("React.createElement")) {
  console.error(
    "Deploy bundle contains React.createElement — JSX automatic runtime is misconfigured (expected jsx: 'automatic', jsxImportSource: '#jsx')",
  );
  Deno.exit(1);
}

// Guard: the whole point of this bundle is to avoid the native libsql binding.
// `platform: "browser"` should resolve `@libsql/client` to its web export; if a
// native `.node`/hrana-over-native path leaked in, the artifact balloons again.
if (content.includes('.node"') || content.includes("libsql/client/.")) {
  console.error(
    "Deploy bundle references a native libsql binding — expected the pure-JS web client via platform: 'browser'",
  );
  Deno.exit(1);
}

console.log(
  `Build complete: dist/deploy.js (${content.length} bytes); source map dist/deploy.js.map`,
);

esbuild.stop();
