/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl } from "@std/path";
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
  // Emit a linked source map so deploys can upload it to Sentry for readable
  // (un-minified) stack traces. Harmless when no upload runs — the deployed
  // bundle just carries a `sourceMappingURL` comment.
  sourcemap: true,
});

// esbuild.build() throws on failure, so if we reach here the output file exists.
// Re-point the source map link at the deployed filename (esbuild names it after
// the bundle, `edge.js.map`) so Sentry's `sourcemaps` tooling can pair the
// deployed `bunny-script.ts` with `bunny-script.ts.map`.
const content = (await Deno.readTextFile("./dist/edge.js")).replace(
  "//# sourceMappingURL=edge.js.map",
  "//# sourceMappingURL=bunny-script.ts.map",
);

// Guard: the app renders with a custom JSX runtime (#jsx), never React. If
// esbuild ever falls back to the classic JSX transform, the bundle references
// an undefined `React` and every page 500s at runtime ("React is not defined").
// Tests don't catch this (they run TSX under Deno), so assert on the bundle.
if (content.includes("React.createElement")) {
  console.error(
    "Edge bundle contains React.createElement — JSX automatic runtime is misconfigured (expected jsx: 'automatic', jsxImportSource: '#jsx')",
  );
  Deno.exit(1);
}

// Bunny Edge Scripting has a 10MB script size limit
const BUNNY_MAX_SCRIPT_SIZE = 10_000_000;
if (content.length > BUNNY_MAX_SCRIPT_SIZE) {
  console.error(
    `Bundle size ${content.length} bytes exceeds Bunny's ${BUNNY_MAX_SCRIPT_SIZE} byte limit`,
  );
  Deno.exit(1);
}

await Deno.writeTextFile("./bunny-script.ts", content);

// Ship the source map next to the deployed bundle so the deploy workflow can
// upload it to Sentry (matched to the release baked into the build).
await Deno.copyFile("./dist/edge.js.map", "./bunny-script.ts.map");

// Write the build tag so the release workflow can use it as the git tag.
// This ensures the release tag exactly matches the baked-in BUILD_TIMESTAMP.
await Deno.writeTextFile(".build-tag", isoToTag(BUILD_ISO));

console.log(`Build complete: bunny-script.ts (${content.length} bytes)`);

// Clean up esbuild
esbuild.stop();
