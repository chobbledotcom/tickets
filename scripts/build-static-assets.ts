/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl, resolve } from "@std/path";
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

/**
 * The client JS bundles as data. One build session uses this config for the
 * initial outputs, dependency graph, and incremental mutation rebuilds.
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

export interface StaticAssetBuild {
  affected(file: string): StaticBundle[];
  dispose(): Promise<void>;
  rebuild(bundles: StaticBundle[]): Promise<boolean>;
  restore(bundles: StaticBundle[]): Promise<void>;
}

interface BuiltBundle {
  baseline: Uint8Array;
  bundle: StaticBundle;
  context: esbuild.BuildContext;
  metafile: esbuild.Metafile;
}

interface BundleContext {
  context: esbuild.BuildContext;
}

const disposeContexts = (contexts: BundleContext[]): Promise<void> =>
  Promise.all(contexts.map(({ context }) => context.dispose())).then(() => {});

const outfileOf = (bundle: StaticBundle): string =>
  resolve(Deno.cwd(), bundle.options.outfile as string);

const buildGraph = (bundles: BuiltBundle[]): Map<string, StaticBundle[]> => {
  const graph = new Map<string, StaticBundle[]>();
  for (const built of bundles) {
    for (const input of Object.keys(built.metafile.inputs)) {
      const file = resolve(Deno.cwd(), input);
      const affected = graph.get(file);
      if (affected) affected.push(built.bundle);
      else graph.set(file, [built.bundle]);
    }
  }
  return graph;
};

const createBundleContexts = async (): Promise<
  Array<{ bundle: StaticBundle; context: esbuild.BuildContext }>
> => {
  const created: Array<{
    bundle: StaticBundle;
    context: esbuild.BuildContext;
  }> = [];
  try {
    for (const bundle of STATIC_JS_BUNDLES) {
      created.push({
        bundle,
        context: await esbuild.context({
          ...bundle.options,
          logLevel: "silent",
          metafile: true,
        }),
      });
    }
    return created;
  } catch (error) {
    await disposeContexts(created);
    throw error;
  }
};

export const buildStaticAssets = async (
  options: { quiet?: boolean } = {},
): Promise<StaticAssetBuild> => {
  const quiet = options.quiet ?? false;
  const contexts = await createBundleContexts();
  try {
    const [, ...results] = await Promise.all([
      buildCss(quiet),
      ...contexts.map(({ context }) => context.rebuild()),
    ]);
    const bundles = await Promise.all(
      contexts.map(async ({ bundle, context }, index): Promise<BuiltBundle> => {
        if (!quiet) {
          console.log(
            `${bundle.label} build complete: ${bundle.options.outfile}`,
          );
        }
        return {
          baseline: await Deno.readFile(outfileOf(bundle)),
          bundle,
          context,
          metafile: results[index]!.metafile!,
        };
      }),
    );
    const graph = buildGraph(bundles);
    const byBundle = new Map(bundles.map((built) => [built.bundle, built]));
    return {
      affected: (file) => graph.get(resolve(Deno.cwd(), file)) ?? [],
      dispose: () => disposeContexts(bundles),
      rebuild: async (affected) => {
        try {
          await Promise.all(
            affected.map((bundle) => byBundle.get(bundle)!.context.rebuild()),
          );
          return true;
        } catch {
          return false;
        }
      },
      restore: (affected) =>
        Promise.all(
          affected.map((bundle) => {
            const built = byBundle.get(bundle)!;
            return Deno.writeFile(outfileOf(bundle), built.baseline);
          }),
        ).then(() => {}),
    };
  } catch (error) {
    await disposeContexts(contexts);
    throw error;
  }
};

if (import.meta.main) {
  const build = await buildStaticAssets();
  await build.dispose();
}
