/**
 * Bench-only entry point: the same bundle contents as `src/serve-app.ts`,
 * but every app module evaluates lazily on the first request instead of at
 * import time (esbuild keeps dynamically-imported modules wrapped in lazy
 * initialisers). Comparing its import time against the real entry separates
 * "parse + compile the bundle" from "run the eager modules' top-level code".
 */
export const serveHandler = async (request: Request): Promise<Response> =>
  (await import("#src/serve-app.ts")).serveHandler(request);
