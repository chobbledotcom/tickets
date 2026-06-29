/**
 * Ticket Reservation System - Deno Deploy entry point.
 *
 * Serves the app with `Deno.serve` using the shared production handler. Built
 * into a self-contained bundle by `scripts/build-deploy.ts` (esbuild, browser
 * platform → the pure-JS `@libsql/client/web` instead of the native client), so
 * the deployed artifact is a few MB rather than the ~78MB native-libsql
 * dependency graph Deno Deploy would otherwise resolve and fail to upload.
 *
 * Deno Deploy supplies the listening port, so `Deno.serve` is called without an
 * explicit one.
 */

import { serveHandler } from "./serve-app.ts";

Deno.serve(serveHandler);
