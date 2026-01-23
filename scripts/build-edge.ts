/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Inlines environment variables since they're not available at edge runtime
 */

import * as esbuild from "esbuild";

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
const NODEJS_GLOBALS_BANNER = `import * as process from "node:process";
import { Buffer } from "node:buffer";
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
`;

const result = await esbuild.build({
  entryPoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  platform: "browser",
  format: "esm",
  minify: true,
  bundle: true,
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
  banner: { js: NODEJS_GLOBALS_BANNER },
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
