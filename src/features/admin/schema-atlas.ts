/** The system-map page: the site's declared state machines, derived from the
 * code that runs them. Owner-only — it is reference material, not a per-role
 * surface, and it explains money-handling rules. */

import { ownerPage } from "#routes/auth.ts";
import { defineRoutes } from "#routes/router.ts";
import { scanJointAnomalies } from "#shared/db/joint-state-scan.ts";
import { settings } from "#shared/db/settings.ts";
import { adminSchemaAtlasPage } from "#templates/admin/schema-atlas.tsx";

const handleSchemaAtlasGet = ownerPage(async (session) =>
  adminSchemaAtlasPage(session, settings.theme, await scanJointAnomalies()),
);

export const adminHandlers = defineRoutes({
  "GET /admin/schema": handleSchemaAtlasGet,
});
