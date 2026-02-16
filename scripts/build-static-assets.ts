/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { fromFileUrl } from "@std/path";

const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));
const denoImports: Record<string, string> = denoConfig.imports;

const projectRoot = fromFileUrl(new URL("..", import.meta.url));

const buildBundle = async (label: string, options: esbuild.BuildOptions): Promise<void> => {
  const result = await esbuild.build(options);
  if (result.errors.length > 0) {
    console.error(`${label} build failed:`);
    for (const log of result.errors) {
      console.error(log);
    }
    Deno.exit(1);
  }
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

/** Resolve #-prefixed imports using the deno.json import map */
const denoImportMapPlugin: Plugin = {
  name: "deno-import-map",
  setup(build) {
    build.onResolve({ filter: /^#/ }, (args) => {
      for (const [key, value] of Object.entries(denoImports)) {
        if (typeof value !== "string" || !value.startsWith("./")) continue;
        if (key.endsWith("/") && args.path.startsWith(key)) {
          return { path: projectRoot + value.slice(2) + args.path.slice(key.length) };
        }
        if (args.path === key) {
          return { path: projectRoot + value.slice(2) };
        }
      }
      return undefined;
    });
  },
};

/** Resolve @iframe-resizer/* and auto-console-group using Deno's import resolution */
const iframeResizerResolvePlugin: Plugin = {
  name: "iframe-resizer-resolve",
  setup(build) {
    build.onResolve({ filter: /^(@iframe-resizer\/|auto-console-group)/ }, (args) => ({
      path: fromFileUrl(import.meta.resolve(args.path)),
    }));
  },
};

export const buildStaticAssets = async (options: { stop?: boolean } = {}): Promise<void> => {
  await buildBundle("Scanner", {
    entryPoints: ["./src/client/scanner.js"],
    outfile: "./src/static/scanner.js",
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
    plugins: [denoNpmResolvePlugin],
  });

  await buildBundle("Admin", {
    entryPoints: ["./src/client/admin.ts"],
    outfile: "./src/static/admin.js",
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
    plugins: [denoImportMapPlugin],
  });

  await buildBundle("Embed", {
    entryPoints: ["./src/client/embed.ts"],
    outfile: "./src/static/embed.js",
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
  });

  await buildBundle("iframe-resizer-parent", {
    entryPoints: ["./src/client/iframe-resizer-parent.ts"],
    outfile: "./src/static/iframe-resizer-parent.js",
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
    plugins: [iframeResizerResolvePlugin],
  });

  await buildBundle("iframe-resizer-child", {
    entryPoints: ["./src/client/iframe-resizer-child.ts"],
    outfile: "./src/static/iframe-resizer-child.js",
    platform: "browser",
    format: "iife",
    bundle: true,
    minify: true,
    banner: { js: "window.iframeResizer={license:'GPLv3'};" },
    plugins: [iframeResizerResolvePlugin],
  });

  if (options.stop) {
    esbuild.stop();
  }
};

if (import.meta.main) {
  await buildStaticAssets({ stop: true });
}
