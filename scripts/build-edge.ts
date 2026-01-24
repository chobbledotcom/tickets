/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Inlines environment variables since they're not available at edge runtime
 */

import * as esbuild from "esbuild";
import type { Plugin } from "esbuild";

// Read static assets at build time for inlining
const STATIC_ASSETS: Record<string, string> = {
  "favicon.svg": await Deno.readTextFile("./src/static/favicon.svg"),
  "mvp.css": await Deno.readTextFile("./src/static/mvp.css"),
};

/**
 * Plugin to inline static assets and handle Deno-specific imports
 * Replaces Deno.readTextFileSync calls with pre-read content
 */
const inlineAssetsPlugin: Plugin = {
  name: "inline-assets",
  setup(build) {
    // Replace the assets module with inlined content
    build.onResolve({ filter: /routes\/assets\.ts$/ }, (args) => ({
      path: args.path,
      namespace: "inline-assets",
    }));

    build.onLoad({ filter: /.*/, namespace: "inline-assets" }, () => ({
      contents: `
        const faviconSvg = ${JSON.stringify(STATIC_ASSETS["favicon.svg"])};
        const mvpCss = ${JSON.stringify(STATIC_ASSETS["mvp.css"])};

        const CACHE_HEADERS = {
          "cache-control": "public, max-age=31536000, immutable",
        };

        export const handleMvpCss = () =>
          new Response(mvpCss, {
            headers: { "content-type": "text/css; charset=utf-8", ...CACHE_HEADERS },
          });

        export const handleFavicon = () =>
          new Response(faviconSvg, {
            headers: { "content-type": "image/svg+xml", ...CACHE_HEADERS },
          });
      `,
      loader: "ts",
    }));
  },
};

// Environment variable configuration: undefined = required, string = default value
const ENV_CONFIG: Record<string, string | undefined> = {
  DB_URL: undefined,
  DB_TOKEN: undefined,
  DB_ENCRYPTION_KEY: undefined,
  ALLOWED_DOMAIN: undefined,
  STRIPE_SECRET_KEY: "",
  CURRENCY_CODE: "GBP",
};

const missing = Object.entries(ENV_CONFIG)
  .filter(([key, defaultVal]) => defaultVal === undefined && !Deno.env.get(key))
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );
  Deno.exit(1);
}

// Read env vars with defaults
const ENV_VARS = Object.fromEntries(
  Object.entries(ENV_CONFIG).map(([key, defaultVal]) => [
    key,
    Deno.env.get(key) ?? defaultVal ?? "",
  ]),
);

// Banner to inject Node.js globals that many packages expect (per Bunny docs)
// and Deno.env shim for inlined environment variables
const NODEJS_GLOBALS_BANNER = `import * as process from "node:process";
import { Buffer } from "node:buffer";
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
`;

// Create Deno.env shim with inlined environment variables
// Force override Deno.env since Bunny Edge is Deno-based and has its own Deno.env
// that doesn't have access to our build-time environment variables
const DENO_ENV_SHIM = `const __INLINED_ENV__ = ${JSON.stringify(ENV_VARS)};
globalThis.Deno ??= {};
globalThis.Deno.env = { get: (key) => __INLINED_ENV__[key] };
`;

const result = await esbuild.build({
  entryPoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  platform: "browser",
  format: "esm",
  minify: true,
  bundle: true,
  plugins: [inlineAssetsPlugin],
  external: [
    "@bunny.net/edgescript-sdk",
    "@libsql/client",
    "@libsql/client/web",
  ],
  define: Object.fromEntries(
    Object.entries(ENV_VARS).map(([key, value]) => [
      `process.env.${key}`,
      JSON.stringify(value),
    ]),
  ),
  banner: { js: NODEJS_GLOBALS_BANNER + DENO_ENV_SHIM },
});

if (result.errors.length > 0) {
  console.error("Build failed:");
  for (const log of result.errors) {
    console.error(log);
  }
  Deno.exit(1);
}

const outputPath = "./dist/bunny-script.js";
let content: string;
try {
  content = await Deno.readTextFile(outputPath);
} catch {
  console.error("No output file generated");
  Deno.exit(1);
}

// Rewrite package imports to esm.sh URLs for edge runtime
// Note: Both @libsql/client and @libsql/client/web get rewritten to the web version
const finalContent = content
  .replace(
    /from\s+["']@bunny\.net\/edgescript-sdk["']/g,
    'from "https://esm.sh/@bunny.net/edgescript-sdk@0.10.0"',
  )
  .replace(
    /from\s+["']@libsql\/client\/web["']/g,
    'from "https://esm.sh/@libsql/client@0.6.0/web"',
  )
  .replace(
    /from\s+["']@libsql\/client["']/g,
    'from "https://esm.sh/@libsql/client@0.6.0/web"',
  );

await Deno.writeTextFile("./bunny-script.ts", finalContent);

console.log("Build complete: bunny-script.ts");

// Clean up esbuild
esbuild.stop();

export {};
