#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { runDenoScript } from "#scripts/script-runner.ts";
import { runSiteMigrationTui } from "#scripts/site-migration/run.ts";
import { fetchSites } from "#scripts/site-migration/sites.ts";
import {
  migrationInterruption,
  tursoMigrationDeps,
} from "#scripts/turso-migration-entry.ts";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { requireSuccess } from "#shared/result.ts";

const signal = migrationInterruption();

await runDenoScript(async (io) =>
  runSiteMigrationTui({
    ...(await tursoMigrationDeps(io, signal, "tickets-site-migration-")),
    fetchSites: (instance) => fetchSites(instance, fetch, signal),
    setSiteSecrets: async (bunnyApiKey, scriptId, secrets) => {
      // The Bunny client reads its key from the environment, like a site does.
      Deno.env.set("BUNNY_API_KEY", bunnyApiKey);
      requireSuccess(
        await bunnyHostingProvider.setSecrets(String(scriptId), secrets),
      );
    },
  }),
);
