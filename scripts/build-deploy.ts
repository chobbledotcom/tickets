/**
 * Build script for Deno Deploy.
 *
 * Produces a single self-contained ESM bundle (`dist/deploy.js`) that Deno
 * Deploy serves directly, so the deployed artifact is a few MB rather than the
 * ~78MB dependency graph Deploy would resolve from source (the native
 * `@libsql/client` binding plus the Stripe/SumUp/Sentry SDKs), whose artifact
 * upload exceeds Deploy's limit.
 *
 * The bundling pipeline is shared with `scripts/build-edge.ts` via
 * `scripts/edge-bundle-lib.ts` (same asset/wasm inlining, Node-global banner,
 * crypto shim, and `platform: "browser"` — which resolves `@libsql/client` to
 * its pure-JS `web` export). This script supplies only the Deno Deploy
 * specifics: the entry point (`src/deploy.ts`, a `Deno.serve` wrapper), the
 * output path, and the native-libsql guard. There is no Bunny 10MB script-size
 * ceiling and no release-tag emission; the built `dist/deploy.js` is the
 * deployed artifact.
 */

import { buildEdgeBundle } from "./edge-bundle-lib.ts";
import { nativeLibsqlGuard } from "./edge-bundle-modules.ts";

await buildEdgeBundle({
  emit: ({ content }) => {
    console.log(
      `Build complete: dist/deploy.js (${content.length} bytes); source map dist/deploy.js.map`,
    );
    return Promise.resolve();
  },
  entryPoint: "./src/deploy.ts",
  guards: [nativeLibsqlGuard],
  label: "Deploy",
  outfile: "deploy.js",
});
