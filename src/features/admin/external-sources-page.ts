/**
 * The owner-only read view of the external sources directory.
 *
 * The directory is written through the admin API. This page shows what the
 * database holds, so an operator can check it without any other tool.
 */

/* jscpd:ignore-start */
import {
  getAllExternalSources,
  listExternalSourceLinks,
} from "#db/external-sources/queries.ts";
import { settings } from "#db/settings.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { authResponsePage, pageGuardFor } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminDestinationAt, adminPattern } from "#shared/admin-surface.ts";
import {
  adminExternalSourcesPage,
  type ExternalSourceEntry,
} from "#templates/admin/external-sources.tsx";

/* jscpd:ignore-end */

const LIST_PATH = adminPattern("externalSources");

/** Every source with the links it holds, in the order they were made. */
const loadDirectory = async (): Promise<ExternalSourceEntry[]> => {
  const sources = await getAllExternalSources();
  return Promise.all(
    sources.map(async (source) => ({
      links: await listExternalSourceLinks(source.id, { kind: "all" }),
      source,
    })),
  );
};

const handleExternalSourcesGet: TypedRouteHandler<"GET /admin/external-sources"> =
  authResponsePage(pageGuardFor(adminDestinationAt(LIST_PATH)))(
    async (session, _request, flash) =>
      settings.features.externalSources
        ? htmlResponse(
            adminExternalSourcesPage(
              session,
              await loadDirectory(),
              flash.error,
              flash.success,
            ),
          )
        : notFoundResponse(),
  );

export const adminHandlers = defineAdminRoutes({
  "GET /admin/external-sources": handleExternalSourcesGet,
});
