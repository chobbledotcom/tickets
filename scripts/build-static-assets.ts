/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import { fromFileUrl, resolve } from "@std/path";
import * as esbuild from "esbuild";
import * as sass from "sass";
import { projectRoot } from "./project-root.ts";
import { writeStaticAssetManifest } from "./static-assets/cache.ts";
import {
  CSS_ENTRY,
  STATIC_ASSET_OUTFILES,
  staticAssetOutputFiles,
} from "./static-assets/outfiles.ts";
import { withGeneratedOutputRollback } from "./static-assets/output-rollback.ts";
import {
  createStaticAssetBuild,
  disposeStaticBundleContexts,
  rebuildStaticBundleContexts,
  type StaticAssetBuild,
  type StaticBundle,
  settleAll,
} from "./static-assets/session.ts";

/**
 * deno.json path the deno-loader uses to resolve every bundle's imports —
 * the `#` import map, npm/jsr specifiers, and each package's browser entry —
 * exactly as the edge build (`build-edge.ts`) does. This replaces the
 * per-package hand-rolled resolve plugins this file used to carry.
 */
const configPath = fromFileUrl(new URL("../deno.json", import.meta.url));

/**
 * The loader ships its own esbuild type declarations, whose PluginBuild type can
 * drift from the npm esbuild package even though the runtime plugin shape is the
 * same. Keep that incompatibility at this adapter boundary.
 */
const denoLoaderPlugins = (): esbuild.Plugin[] =>
  denoPlugins({ configPath }) as unknown as esbuild.Plugin[];

/** Compile the SCSS stylesheet to the served CSS file, reporting every
 *  stylesheet it read so the build cache can watch them all. */
const buildCss = async (quiet = false): Promise<string[]> => {
  const { css, loadedUrls } = sass.compile(CSS_ENTRY, { style: "compressed" });
  await Deno.writeTextFile(STATIC_ASSET_OUTFILES.css, css);
  if (!quiet) console.log(`CSS build complete: ${STATIC_ASSET_OUTFILES.css}`);
  return loadedUrls
    .filter((url) => url.protocol === "file:")
    .map((url) => fromFileUrl(url));
};

/** A browser bundle built the standard way (bundled, minified, IIFE, deno
 *  loader plugins). `extra` overrides that default per bundle — the order
 *  widget needs ESM, the iframe-resizer child needs a licence banner. */
const browserBundle = (
  label: string,
  entryPoint: string,
  outfile: string,
  extra: Omit<esbuild.BuildOptions, "outfile"> = {},
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

const outfileOf = (bundle: StaticBundle): string =>
  resolve(Deno.cwd(), bundle.options.outfile);

/** Files outside the bundled sources that still decide the build's output:
 *  the import map and lockfile every bundle resolves through, and the bundle
 *  list itself. A change to any of them must force a rebuild. */
const BUILD_DEFINITION_FILES = [
  "deno.json",
  "deno.lock",
  "scripts/build-static-assets.ts",
];

const inputsOf = (
  result: esbuild.BuildResult | undefined,
  bundle: StaticBundle,
): string[] => {
  if (!result?.metafile) {
    throw new Error(`Static bundle has no build metadata: ${bundle.label}`);
  }
  return Object.keys(result.metafile.inputs);
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
    await disposeStaticBundleContexts(created);
    throw error;
  }
};

/** Bundle and compile every browser asset from scratch. `quiet` has no
 *  default on purpose: `prepareStaticAssets` is the one place that decides it,
 *  so the two entry points cannot drift. */
export const runStaticAssetBuild = async (
  quiet: boolean,
): Promise<StaticAssetBuild> => {
  let contexts: Awaited<ReturnType<typeof createBundleContexts>> = [];
  return withGeneratedOutputRollback(
    staticAssetOutputFiles(),
    async () => {
      contexts = await createBundleContexts();
      const cssBuild = buildCss(quiet);
      const bundleBuild = rebuildStaticBundleContexts(contexts);
      await settleAll([cssBuild, bundleBuild]);
      const results = await bundleBuild;
      const bundles = await Promise.all(
        contexts.map(async ({ bundle, context }, index) => {
          if (!quiet) {
            console.log(
              `${bundle.label} build complete: ${bundle.options.outfile}`,
            );
          }
          return {
            baseline: await Deno.readFile(outfileOf(bundle)),
            bundle,
            context,
            inputs: inputsOf(results[index], bundle),
          };
        }),
      );
      await writeStaticAssetManifest(
        [
          ...bundles.flatMap((built) =>
            built.inputs.map((input) => resolve(Deno.cwd(), input)),
          ),
          ...(await cssBuild),
          ...BUILD_DEFINITION_FILES.map((file) => resolve(projectRoot, file)),
          ...staticAssetOutputFiles(),
        ],
        staticAssetOutputFiles(),
      );
      return createStaticAssetBuild(bundles, {
        resolve: (file) => resolve(Deno.cwd(), file),
        stop: () => esbuild.stop(),
        write: (file, contents) =>
          Deno.writeFile(resolve(Deno.cwd(), file), contents),
      });
    },
    () => [() => disposeStaticBundleContexts(contexts), () => esbuild.stop()],
  );
};

if (import.meta.main) {
  const build = await runStaticAssetBuild(false);
  await build.dispose();
}
