/**
 * Build script for Bunny Edge deployment
 * Bundles edge script into a single deployable file
 * Secrets are read at runtime via Bunny's native environment variables
 *
 * The bundling pipeline is shared with `scripts/build-deploy.ts` via
 * `scripts/edge-bundle-lib.ts`; this script supplies only the Bunny-specific
 * bits: the entry point, the 10MB script-size ceiling, the source-map link
 * rename, and the `bunny-script.ts` + release-tag emission.
 */

import { isoToTag } from "./build-tag.ts";
import { buildEdgeBundle } from "./edge-bundle-lib.ts";
import { bundleSizeGuard, renameSourceMapLink } from "./edge-bundle-modules.ts";

// Bunny Edge Scripting has a 10MB script size limit
const BUNNY_MAX_SCRIPT_SIZE = 10_000_000;

await buildEdgeBundle({
  emit: async ({ content, buildIso }) => {
    await Deno.writeTextFile("./bunny-script.ts", content);

    // Ship the source map next to the deployed bundle so the deploy workflow can
    // upload it to Sentry (matched to the release baked into the build).
    await Deno.copyFile("./dist/edge.js.map", "./bunny-script.ts.map");

    // Write the build tag so the release workflow can use it as the git tag.
    // This ensures the release tag exactly matches the baked-in BUILD_TIMESTAMP.
    await Deno.writeTextFile(".build-tag", isoToTag(buildIso));

    console.log(`Build complete: bunny-script.ts (${content.length} bytes)`);
  },
  entryPoint: "./src/edge.ts",
  guards: [bundleSizeGuard(BUNNY_MAX_SCRIPT_SIZE)],
  label: "Edge",
  outfile: "edge.js",
  // Re-point the source map link at the deployed filename (esbuild names it
  // after the bundle, `edge.js.map`) so Sentry's `sourcemaps` tooling can pair
  // the deployed `bunny-script.ts` with `bunny-script.ts.map`.
  transformContent: (raw) =>
    renameSourceMapLink(raw, "edge.js.map", "bunny-script.ts.map"),
});
