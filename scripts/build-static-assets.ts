/**
 * Build static client assets (admin, scanner, iframe-resizer, embed loader).
 */

import { fromFileUrl } from "@std/path";
import type { Plugin } from "esbuild";
import * as esbuild from "esbuild";

const denoConfig = JSON.parse(await Deno.readTextFile("./deno.json"));
const denoImports: Record<string, string> = denoConfig.imports;

const projectRoot = fromFileUrl(new URL("..", import.meta.url));

const buildBundle = async (
  label: string,
  options: esbuild.BuildOptions,
): Promise<void> => {
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

export const buildStaticAssets = async (
  options: { stop?: boolean } = {},
): Promise<void> => {
  await buildBundle("Scanner", {
    bundle: true,
    entryPoints: ["./src/ui/client/scanner.js"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/scanner.js",
    platform: "browser",
    plugins: [denoNpmResolvePlugin],
  });

  await buildBundle("Admin", {
    bundle: true,
    entryPoints: ["./src/ui/client/admin.ts"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/admin.js",
    platform: "browser",
    plugins: [denoImportMapPlugin],
  });

  await buildBundle("Embed", {
    bundle: true,
    entryPoints: ["./src/ui/client/embed.ts"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/embed.js",
    platform: "browser",
  });

  await buildBundle("Contact", {
    bundle: true,
    entryPoints: ["./src/ui/client/contact.ts"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/contact.js",
    platform: "browser",
    plugins: [botpoisonResolvePlugin],
  });

  await buildBundle("iframe-resizer-parent", {
    bundle: true,
    entryPoints: ["./src/ui/client/iframe-resizer-parent.ts"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/iframe-resizer-parent.js",
    platform: "browser",
    plugins: [iframeResizerResolvePlugin],
  });

  await buildBundle("iframe-resizer-child", {
    banner: { js: "window.iframeResizer={license:'GPLv3'};" },
    bundle: true,
    entryPoints: ["./src/ui/client/iframe-resizer-child.ts"],
    format: "iife",
    minify: true,
    outfile: "./src/ui/static/iframe-resizer-child.js",
    platform: "browser",
    plugins: [iframeResizerResolvePlugin],
  });

  if (options.stop) {
    esbuild.stop();
  }
};

if (import.meta.main) {
  await buildStaticAssets({ stop: true });
}
