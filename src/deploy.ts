/**
 * Ticket Reservation System - Deno Deploy entry point.
 *
 * Serves the app with `Deno.serve` using the shared production handler. Built
 * into a self-contained bundle by `scripts/build-deploy.ts`: esbuild with the
 * browser platform pulls in the pure-JS `@libsql/client/web` instead of the
 * native client. The deployed artifact is then a few MB. Deno Deploy otherwise
 * tries to resolve the ~78MB native-libsql dependency graph and fails to upload.
 *
 * Deno Deploy supplies the listening port, so `Deno.serve` is called without an
 * explicit one.
 */

import { denoServeHandler } from "./serve-app.ts";

Deno.serve(denoServeHandler);
