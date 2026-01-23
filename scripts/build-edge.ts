/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Inlines environment variables since they're not available at edge runtime
 */

// Required environment variables - build fails if not set
const REQUIRED_ENV_VARS = [
  "DB_URL",
  "DB_TOKEN",
  "DB_ENCRYPTION_KEY",
  "ALLOWED_DOMAIN",
] as const;
const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // biome-ignore lint/suspicious/noConsole: Build script output
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

// Environment variables to inline (read at build time)
const ENV_VARS = {
  DB_URL: process.env.DB_URL as string,
  DB_TOKEN: process.env.DB_TOKEN as string,
  DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY as string,
  ALLOWED_DOMAIN: process.env.ALLOWED_DOMAIN as string,
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
    "process.env.DB_ENCRYPTION_KEY": JSON.stringify(ENV_VARS.DB_ENCRYPTION_KEY),
    "process.env.STRIPE_SECRET_KEY": JSON.stringify(ENV_VARS.STRIPE_SECRET_KEY),
    "process.env.CURRENCY_CODE": JSON.stringify(ENV_VARS.CURRENCY_CODE),
    "process.env.ALLOWED_DOMAIN": JSON.stringify(ENV_VARS.ALLOWED_DOMAIN),
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
