/* jscpd:ignore-start */

import { initDb } from "#db/migrations.ts";
import { settings } from "#db/settings.ts";
import { requestScopedHandler } from "#routes/request-scopes.ts";
import {
  loadEffectiveDomain,
  seedEffectiveDomainHost,
} from "#shared/config.ts";
import { reportMaintenanceFailure } from "#shared/maintenance/report.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import { scheduledResponse } from "#shared/scheduled-access.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
/* jscpd:ignore-end */

export const handleScheduledRequest = requestScopedHandler(async (request) => {
  const url = new URL(request.url);
  // Seed the request's own host before anything reads a domain, the way the
  // fetch path does. The failure report's ntfy title reads it, and no seed
  // made outside this context reaches it.
  seedEffectiveDomainHost(url);
  try {
    await initDb();
    await settings.loadKeys([
      CONFIG_KEYS.BUNNY_SUBDOMAIN,
      CONFIG_KEYS.CUSTOM_DOMAIN,
      CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
      CONFIG_KEYS.SETUP_COMPLETE,
    ]);
    loadEffectiveDomain(url);
    if (!(await settings.setup.isComplete())) {
      throw new Error("Scheduled maintenance requires completed setup");
    }
    const { MAINTENANCE_TASKS } = await import(
      "#shared/maintenance/registry.ts"
    );
    await maintenance.run(MAINTENANCE_TASKS);
    return scheduledResponse(204);
  } catch (error) {
    reportMaintenanceFailure("scheduled maintenance failed", error);
    return scheduledResponse(503);
  }
});
