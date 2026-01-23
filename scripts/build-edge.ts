/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Inlines environment variables since they're not available at edge runtime
 */

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
  .filter(([key, defaultVal]) => defaultVal === undefined && !process.env[key])
  .map(([key]) => key);

if (missing.length > 0) {
  // biome-ignore lint/suspicious/noConsole: Build script output
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

// Read env vars with defaults
const ENV_VARS = Object.fromEntries(
  Object.entries(ENV_CONFIG).map(([key, defaultVal]) => [
    key,
    process.env[key] ?? defaultVal ?? "",
  ]),
);

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
  define: Object.fromEntries(
    Object.entries(ENV_VARS).map(([key, value]) => [
      `process.env.${key}`,
      JSON.stringify(value),
    ]),
  ),
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
