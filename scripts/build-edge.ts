/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 */

const result = await Bun.build({
  entrypoints: ["./src/edge/bunny-script.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  external: [
    "@bunny.net/edgescript-sdk",
    "@libsql/client/web",
    "@thednp/dommatrix",
    "node-html-parser",
    "pdf-parse",
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const outputPath = result.outputs[0]?.path;
if (!outputPath) {
  console.error("No output file generated");
  process.exit(1);
}

const content = await Bun.file(outputPath).text();

// Rewrite package imports to esm.sh URLs for edge runtime
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
    /from\s+["']@thednp\/dommatrix["']/g,
    'from "https://esm.sh/@thednp/dommatrix@3.0.2"',
  )
  .replace(
    /from\s+["']node-html-parser["']/g,
    'from "https://esm.sh/node-html-parser@6.1.13"',
  )
  .replace(/from\s+["']pdf-parse["']/g, 'from "https://esm.sh/pdf-parse@2.4.5"')
  // Also rewrite dynamic imports for pdf-parse
  .replace(
    /import\s*\(\s*["']pdf-parse["']\s*\)/g,
    'import("https://esm.sh/pdf-parse@2.4.5")',
  );

await Bun.write("./bunny-script.ts", finalContent);

console.log("Build complete: bunny-script.ts");

export {};
