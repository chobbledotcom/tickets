/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import { fromFileUrl } from "@std/path";
import type { Plugin } from "esbuild";
import * as esbuild from "esbuild";
import * as sass from "sass";

const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));
const denoImports: Record<string, string> = denoConfig.imports;

const projectRoot = fromFileUrl(new URL("..", import.meta.url));

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

/** Resolve npm bare specifiers using Deno's import resolution */
const denoNpmResolvePlugin: Plugin = {
  name: "deno-npm-resolve",
  setup(build) {
    build.onResolve({ filter: /^jsqr$/ }, () => ({
      path: fromFileUrl(import.meta.resolve("jsqr")),
    }));
  },
};

/** Match a single import map entry against a specifier */
const matchImportEntry = (
  specifier: string,
  key: string,
  value: unknown,
): string | undefined => {
  if (typeof value !== "string" || !value.startsWith("./")) return undefined;
  if (key.endsWith("/") && specifier.startsWith(key)) {
    return projectRoot + value.slice(2) + specifier.slice(key.length);
  }
  if (specifier === key) return projectRoot + value.slice(2);
  return undefined;
};

/** Resolve a #-prefixed specifier using the deno.json import map */
const resolveImportMap = (specifier: string): string | undefined => {
  for (const [key, value] of Object.entries(denoImports)) {
    const resolved = matchImportEntry(specifier, key, value);
    if (resolved) return resolved;
  }
  return undefined;
};

/** Resolve #-prefixed imports using the deno.json import map */
const denoImportMapPlugin: Plugin = {
  name: "deno-import-map",
  setup(build) {
    build.onResolve({ filter: /^#/ }, (args) => {
      const resolved = resolveImportMap(args.path);
      return resolved ? { path: resolved } : undefined;
    });
  },
};

/** Resolve @iframe-resizer/* and auto-console-group using Deno's import resolution */
const iframeResizerResolvePlugin: Plugin = {
  name: "iframe-resizer-resolve",
  setup(build) {
    build.onResolve(
      { filter: /^(@iframe-resizer\/|auto-console-group)/ },
      (args) => ({
        path: fromFileUrl(import.meta.resolve(args.path)),
      }),
    );
  },
};

/** Resolve @botpoison/browser using Deno's import resolution */
const botpoisonResolvePlugin: Plugin = {
  name: "botpoison-resolve",
  setup(build) {
    build.onResolve({ filter: /^@botpoison\/browser$/ }, () => ({
      path: fromFileUrl(import.meta.resolve("@botpoison/browser")),
    }));
  },
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
      plugins: [denoNpmResolvePlugin],
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
      plugins: [denoImportMapPlugin],
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
      plugins: [botpoisonResolvePlugin],
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
      plugins: [iframeResizerResolvePlugin],
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
      plugins: [iframeResizerResolvePlugin],
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
