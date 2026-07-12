/**
 * Shared edge-bundle pipeline for the two production builds.
 *
 * `build-edge.ts` (Bunny Edge Scripting) and `build-deploy.ts` (Deno Deploy)
 * produce the same shape of single-file ESM bundle: the same static-asset and
 * codec-wasm inlining, build-info/asset-paths modules, Node-global banner,
 * bare-crypto shim, and `platform: "browser"` config (which resolves
 * `@libsql/client` to its pure-JS `web` export). Everything they share lives
 * here; each caller passes only what genuinely differs — the entry point, any
 * extra guards (the deploy build asserts no native libsql binding leaked in),
 * an optional content transform, and how the built bundle is emitted.
 *
 * The pure string-building and guard logic lives in `edge-bundle-modules.ts`
 * (unit- and mutation-tested); this file is the IO shell that reads assets,
 * drives esbuild, runs the guards, and hands the bundle to `emit`.
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl } from "@std/path";
import type { Plugin } from "esbuild";
import * as esbuild from "esbuild";
import { ASSETS } from "../src/shared/images/wasm-assets.ts";
import { buildStaticAssets } from "./build-static-assets.ts";
import { minifyCss } from "./css-minify.ts";
import {
  buildAssetPathsModule,
  buildAssetsModule,
  buildBuildInfoModule,
  type EdgeBundleGuard,
  reactRuntimeGuard,
} from "./edge-bundle-modules.ts";
import { ASSET_DEFS, buildCdnAssets } from "./edge-cdn-assets.ts";
import {
  buildRemoteModule,
  createPlugin as createWasmPlugin,
  inlineWasmPlugin,
} from "./inline-jsquash-wasm.ts";
import { publishStaticCdnAssets, type StaticCdnConfig } from "./static-cdn.ts";

export type { EdgeBundleGuard } from "./edge-bundle-modules.ts";

export interface EdgeBundleContext {
  /** ISO build timestamp baked into the bundle; reused for the release tag. */
  buildIso: string;
  /** The final bundle text (after `transformContent`). */
  content: string;
}

export interface EdgeBundleOptions {
  /** Publish fixed browser/WASM payloads and bake their immutable CDN URLs. */
  cdnConfig?: StaticCdnConfig | null;
  /** Emit the finished bundle (write files, copy the map, …) and return. */
  emit: (ctx: EdgeBundleContext) => Promise<void>;
  /** Inline empty strings instead of the real asset bodies — for benchmark
   * builds that measure what the inlined payloads themselves cost. */
  emptyInlinedAssets?: boolean;
  /** Entry point to bundle, e.g. `"./src/edge.ts"`. */
  entryPoint: string;
  /** Extra assertions beyond the shared React-runtime guard. */
  guards?: EdgeBundleGuard[];
  /** Human label used in guard messages and the completion log ("Edge"/"Deploy"). */
  label: string;
  /** Basename esbuild writes under `./dist`, e.g. `"edge.js"`. */
  outfile: string;
  /** Reuse already-built client bundles instead of rebuilding them (for the
   * benchmarks that bundle several entry points back to back). */
  skipClientBuild?: boolean;
  /** Transform the raw `dist/<outfile>` text before guards run (e.g. rename the source-map link). */
  transformContent?: (raw: string) => string;
}

// Externalize all Node.js built-in modules (per Bunny docs; Deno Deploy
// provides them natively too).
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

// Banner to inject Node.js globals that many packages expect (per Bunny docs).
// process.env is populated by the runtime's native secrets at runtime.
const NODEJS_GLOBALS_BANNER = `import * as process from "node:process";
import { Buffer } from "node:buffer";
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
`;

// Swaps a real module for a generated one at build time: esbuild resolves any
// import matching `filter` into its own private namespace, then loads that
// namespace from the TypeScript source `buildContents` returns.
const inlineGeneratedModule = (
  build: Parameters<Plugin["setup"]>[0],
  filter: RegExp,
  namespace: string,
  buildContents: () => string,
): void => {
  build.onResolve({ filter }, (args) => ({ namespace, path: args.path }));
  build.onLoad({ filter: /.*/, namespace }, () => ({
    contents: buildContents(),
    loader: "ts",
  }));
};

/**
 * Plugin to inline static assets and handle Deno-specific imports.
 * Replaces Deno.readTextFileSync calls with the pre-read content and the
 * build metadata modules produced by the pure builders.
 */
const inlineAssetsPlugin = (
  buildIso: string,
  buildTs: number,
  staticAssets: Record<string, string>,
  published?: Awaited<ReturnType<typeof publishStaticCdnAssets>>,
): Plugin => ({
  name: "inline-assets",
  setup(build) {
    // Replace build-info module with actual build metadata
    inlineGeneratedModule(build, /build-info\.ts$/, "inline-build-info", () =>
      buildBuildInfoModule(buildIso, Deno.env.get("BUILD_COMMIT") ?? ""),
    );

    // Replace asset paths module with cache-busted version
    inlineGeneratedModule(build, /asset-paths\.ts$/, "inline-asset-paths", () =>
      buildAssetPathsModule(ASSET_DEFS, buildTs, published),
    );

    // Replace the assets module with inlined content
    inlineGeneratedModule(
      build,
      /(features\/assets\.ts$|#routes\/assets\.ts$)/,
      "inline-assets",
      () => buildAssetsModule(ASSET_DEFS, staticAssets, published),
    );
  },
});

/** Read every static asset ASSET_DEFS references, plus the inlined order widget. */
const readStaticAssets = async (
  minifiedCss: string,
): Promise<Record<string, string>> => {
  const staticAssets: Record<string, string> = {
    "favicon.svg": await Deno.readTextFile("./src/ui/static/favicon.svg"),
    "style.css": minifiedCss,
  };

  for (const [filename] of ASSET_DEFS) {
    if (filename === "favicon.svg" || filename === "style.css") continue;
    staticAssets[filename] = await Deno.readTextFile(
      `./src/ui/static/${filename}`,
    );
  }

  // The external-order widget is served by a dynamic route (not an ASSET_DEFS
  // handler), but its body must still be inlined for the bundled runtime, which
  // has no filesystem. Read it here so buildAssetsModule() can bake it in.
  staticAssets["order.js"] = await Deno.readTextFile(
    "./src/ui/static/order.js",
  );

  return staticAssets;
};

/**
 * Run the shared bundle pipeline: build client bundles, inline static assets,
 * bundle the given entry point with esbuild, run the shared and caller guards,
 * then hand the finished bundle to `emit`.
 */
export const buildEdgeBundle = async (
  options: EdgeBundleOptions,
): Promise<void> => {
  const { label, entryPoint, outfile, transformContent, guards } = options;

  // --- Step 1: Build client bundles ---
  if (!options.skipClientBuild) await buildStaticAssets();

  // --- Step 2: Build the edge bundle ---

  // Build timestamp for cache-busting (seconds since epoch)
  const buildTs = Math.floor(Date.now() / 1000);

  // Read static assets at build time for inlining (client bundles freshly built above)
  const rawCss = await Deno.readTextFile("./src/ui/static/style.css");
  const minifiedCss = await minifyCss(rawCss);
  const staticAssets = await readStaticAssets(minifiedCss);
  const inlinedAssets = options.emptyInlinedAssets
    ? Object.fromEntries(Object.keys(staticAssets).map((key) => [key, ""]))
    : staticAssets;
  const published = options.cdnConfig
    ? await publishStaticCdnAssets(
        options.cdnConfig,
        buildCdnAssets(staticAssets),
      )
    : undefined;
  const wasmPlugin = published
    ? createWasmPlugin(() => buildRemoteModule(ASSETS, published.urls))
    : inlineWasmPlugin;

  // Build timestamp — always the current time. Used both as BUILD_TIMESTAMP
  // and (formatted) as the release tag in release builds, so the two always match.
  const buildIso = new Date().toISOString();

  await esbuild.build({
    banner: { js: NODEJS_GLOBALS_BANNER },
    bundle: true,
    define: { "process.env.NODE_ENV": '"production"' },
    entryPoints: [entryPoint],
    external: nodeExternals,
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "#jsx",
    minify: true,
    outdir: "./dist",
    platform: "browser",
    plugins: [
      shimBareNodeCryptoPlugin,
      inlineAssetsPlugin(buildIso, buildTs, inlinedAssets, published),
      wasmPlugin,
      // The loader pins older structural esbuild types; its runtime plugins
      // implement the same API used by our newer esbuild package.
      ...(denoPlugins({
        configPath: fromFileUrl(new URL("../deno.json", import.meta.url)),
      }) as unknown as Plugin[]),
    ],
    // Emit a linked source map so deploys can upload it to Sentry for readable
    // (un-minified) stack traces. Harmless when no upload runs — the deployed
    // bundle just carries a `sourceMappingURL` comment.
    sourcemap: true,
  });

  // esbuild.build() throws on failure, so if we reach here the output file exists.
  const raw = await Deno.readTextFile(`./dist/${outfile}`);
  const content = transformContent ? transformContent(raw) : raw;

  for (const guard of [reactRuntimeGuard(label), ...(guards ?? [])]) {
    if (guard.test(content)) {
      console.error(guard.message);
      Deno.exit(1);
    }
  }

  await options.emit({ buildIso, content });

  // Clean up esbuild
  esbuild.stop();
};
