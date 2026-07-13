/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import * as sass from "sass";

/**
 * deno.json path the deno-loader uses to resolve every bundle's imports —
 * the `#` import map, npm/jsr specifiers, and each package's browser entry —
 * exactly as the edge build (`build-edge.ts`) does. This replaces the
 * per-package hand-rolled resolve plugins this file used to carry.
 */
const configPath = fromFileUrl(new URL("../deno.json", import.meta.url));

const STATIC_DIR = "./src/ui/static";

/**
 * The loader ships its own esbuild type declarations, whose PluginBuild type can
 * drift from the npm esbuild package even though the runtime plugin shape is the
 * same. Keep that incompatibility at this adapter boundary.
 */
const denoLoaderPlugins = (): esbuild.Plugin[] =>
  denoPlugins({ configPath }) as unknown as esbuild.Plugin[];

/**
 * Output files produced by {@link buildStaticAssets}, keyed by bundle. These
 * are generated build artifacts (gitignored), so the test harness uses this
 * list to clean up any it generates after a run.
 */
export const STATIC_ASSET_OUTFILES = {
  admin: `${STATIC_DIR}/admin.js`,
  contact: `${STATIC_DIR}/contact.js`,
  css: `${STATIC_DIR}/style.css`,
  embed: `${STATIC_DIR}/embed.js`,
  iframeResizerChild: `${STATIC_DIR}/iframe-resizer-child.js`,
  iframeResizerParent: `${STATIC_DIR}/iframe-resizer-parent.js`,
  logisticsMap: `${STATIC_DIR}/logistics-map.js`,
  markdownEditor: `${STATIC_DIR}/markdown-editor.js`,
  order: `${STATIC_DIR}/order.js`,
  scanner: `${STATIC_DIR}/scanner.js`,
} as const;

/** Source SCSS stylesheet compiled to {@link STATIC_ASSET_OUTFILES.css}. */
const CSS_ENTRY = `${STATIC_DIR}/style.scss`;

/** Compile the SCSS stylesheet to the served CSS file. */
const buildCss = async (quiet = false): Promise<void> => {
  const { css } = sass.compile(CSS_ENTRY, { style: "compressed" });
  await Deno.writeTextFile(STATIC_ASSET_OUTFILES.css, css);
  if (!quiet) console.log(`CSS build complete: ${STATIC_ASSET_OUTFILES.css}`);
};

const buildBundle = async (
  label: string,
  options: esbuild.BuildOptions,
  quiet = false,
): Promise<void> => {
  const result = await esbuild.build(options);
  if (result.errors.length > 0) {
    console.error(`${label} build failed:`);
    for (const log of result.errors) {
      console.error(log);
    }
    Deno.exit(1);
  }
  if (quiet) return;
  if (options.outfile) {
    console.log(`${label} build complete: ${options.outfile}`);
  } else {
    console.log(`${label} build complete`);
  }
};

/**
 * The client JS bundles as data, so callers other than {@link buildStaticAssets}
 * can rebuild a single bundle with its exact esbuild config — entry point,
 * plugins, format, and all. The mutation tester (`scripts/mutation`) uses this
 * to rebuild only the bundle(s) a mutated source feeds, per mutant, under
 * `--harness`.
 */
export interface StaticBundle {
  label: string;
  options: esbuild.BuildOptions;
}

/** A browser bundle built the standard way (bundled, minified, IIFE, deno
 *  loader plugins). `extra` overrides that default per bundle — the order
 *  widget needs ESM, the iframe-resizer child needs a licence banner. */
const browserBundle = (
  label: string,
  entryPoint: string,
  outfile: string,
  extra: esbuild.BuildOptions = {},
): StaticBundle => ({
  label,
  options: {
    bundle: true,
    entryPoints: [entryPoint],
    format: "iife",
    minify: true,
    outfile,
    platform: "browser",
    plugins: denoLoaderPlugins(),
    ...extra,
  },
});

export const STATIC_JS_BUNDLES: StaticBundle[] = [
  browserBundle(
    "Scanner",
    "./src/ui/client/scanner.js",
    STATIC_ASSET_OUTFILES.scanner,
  ),
  browserBundle(
    "Admin",
    "./src/ui/client/admin.ts",
    STATIC_ASSET_OUTFILES.admin,
  ),
  browserBundle(
    "Logistics map",
    "./src/ui/client/logistics-map.ts",
    STATIC_ASSET_OUTFILES.logisticsMap,
  ),
  browserBundle(
    "Markdown editor",
    "./src/ui/client/markdown-editor.ts",
    STATIC_ASSET_OUTFILES.markdownEditor,
  ),
  browserBundle(
    "Embed",
    "./src/ui/client/embed.ts",
    STATIC_ASSET_OUTFILES.embed,
  ),
  browserBundle(
    "Contact",
    "./src/ui/client/contact.ts",
    STATIC_ASSET_OUTFILES.contact,
  ),
  // ESM (not IIFE): the order widget is loaded as `<script type="module">`,
  // and that module form is what makes the cross-origin CORS gate bite — a
  // classic-script include would bypass it. The `export {}` in order.ts also
  // forces module-only parsing.
  browserBundle(
    "Order",
    "./src/ui/client/order.ts",
    STATIC_ASSET_OUTFILES.order,
    {
      format: "esm",
    },
  ),
  browserBundle(
    "iframe-resizer-parent",
    "./src/ui/client/iframe-resizer-parent.ts",
    STATIC_ASSET_OUTFILES.iframeResizerParent,
  ),
  browserBundle(
    "iframe-resizer-child",
    "./src/ui/client/iframe-resizer-child.ts",
    STATIC_ASSET_OUTFILES.iframeResizerChild,
    { banner: { js: "window.iframeResizer={license:'GPLv3'};" } },
  ),
];

export const buildStaticAssets = async (
  options: { quiet?: boolean; stop?: boolean } = {},
): Promise<void> => {
  const quiet = options.quiet ?? false;
  await Promise.all([
    buildCss(quiet),
    ...STATIC_JS_BUNDLES.map((bundle) =>
      buildBundle(bundle.label, bundle.options, quiet),
    ),
  ]);

  if (options.stop) {
    esbuild.stop();
  }
};

if (import.meta.main) {
  await buildStaticAssets({ stop: true });
}
