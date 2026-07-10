/**
 * Entry point for local development (`deno task start`).
 *
 * Boot checks run eagerly so a misconfigured environment fails at startup;
 * everything else — Sentry, the N+1 guard mode, request handling — comes from
 * the shared production handler, exactly as the edge and Deploy entries use
 * it. Deno.serve prints its own "Listening on" line, so there is no bespoke
 * startup log here.
 */

import { validateBootChecks } from "#shared/boot-checks.ts";
import { devServerPort, serveHandler } from "./serve-app.ts";

validateBootChecks();
Deno.serve({ port: devServerPort() }, serveHandler);
