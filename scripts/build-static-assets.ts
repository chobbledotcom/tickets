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
  scanner: `${STATIC_DIR}/scanner.js`,
} as const;

/** Source SCSS stylesheet compiled to {@link STATIC_ASSET_OUTFILES.css}. */
const CSS_ENTRY = `${STATIC_DIR}/style.scss`;

/**
 * Compile the SCSS stylesheet to the served CSS file. Kept expanded (not
 * minified) for dev/serving parity with the previous hand-written CSS; the edge
 * build minifies it separately when inlining.
 */
const buildCss = async (quiet = false): Promise<void> => {
  const { css } = sass.compile(CSS_ENTRY, { style: "expanded" });
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

export const STATIC_JS_BUNDLES: StaticBundle[] = [
  {
    label: "Scanner",
    options: {
      bundle: true,
      entryPoints: ["./src/ui/client/scanner.js"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.scanner,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
  {
    label: "Admin",
    options: {
      bundle: true,
      entryPoints: ["./src/ui/client/admin.ts"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.admin,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
  {
    label: "Embed",
    options: {
      bundle: true,
      entryPoints: ["./src/ui/client/embed.ts"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.embed,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
  {
    label: "Contact",
    options: {
      bundle: true,
      entryPoints: ["./src/ui/client/contact.ts"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.contact,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
  {
    label: "iframe-resizer-parent",
    options: {
      bundle: true,
      entryPoints: ["./src/ui/client/iframe-resizer-parent.ts"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.iframeResizerParent,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
  {
    label: "iframe-resizer-child",
    options: {
      banner: { js: "window.iframeResizer={license:'GPLv3'};" },
      bundle: true,
      entryPoints: ["./src/ui/client/iframe-resizer-child.ts"],
      format: "iife",
      minify: true,
      outfile: STATIC_ASSET_OUTFILES.iframeResizerChild,
      platform: "browser",
      plugins: [...denoPlugins({ configPath })],
    },
  },
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
