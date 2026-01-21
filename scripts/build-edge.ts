/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Inlines environment variables since they're not available at edge runtime
 */

// Environment variables to inline (read at build time)
const ENV_VARS = {
  DB_URL: process.env.DB_URL || "",
  DB_TOKEN: process.env.DB_TOKEN || "",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  CURRENCY_CODE: process.env.CURRENCY_CODE || "GBP",
};

const result = await Bun.build({
  entrypoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  external: [
    "@bunny.net/edgescript-sdk",
    "@libsql/client",
    "@libsql/client/web",
  ],
  define: {
    "process.env.DB_URL": JSON.stringify(ENV_VARS.DB_URL),
    "process.env.DB_TOKEN": JSON.stringify(ENV_VARS.DB_TOKEN),
    "process.env.ADMIN_PASSWORD": JSON.stringify(ENV_VARS.ADMIN_PASSWORD),
    "process.env.STRIPE_SECRET_KEY": JSON.stringify(ENV_VARS.STRIPE_SECRET_KEY),
    "process.env.CURRENCY_CODE": JSON.stringify(ENV_VARS.CURRENCY_CODE),
  },
});

if (!result.success) {
  // biome-ignore lint/suspicious/noConsole: Build script output
  console.error("Build failed:");
  for (const log of result.logs) {
    // biome-ignore lint/suspicious/noConsole: Build script output
    console.error(log);
  }
  process.exit(1);
}

const outputPath = result.outputs[0]?.path;
if (!outputPath) {
  // biome-ignore lint/suspicious/noConsole: Build script output
  console.error("No output file generated");
  process.exit(1);
}

const content = await Bun.file(outputPath).text();

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

await Bun.write("./bunny-script.ts", finalContent);

// biome-ignore lint/suspicious/noConsole: Build script output
console.log("Build complete: bunny-script.ts");

export {};
