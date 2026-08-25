/** The system-map page: the site's declared state machines, derived from the
 * code that runs them. Owner-only — it is reference material, not a per-role
 * surface, and it explains money-handling rules. */

import { scanSchemaAnomalies } from "#db/schema-anomaly-scan.ts";
import { settings } from "#db/settings.ts";
import { listUnansweredSumupMoney } from "#db/sumup-recovery.ts";
import { ownerPage } from "#routes/auth.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminSchemaAtlasPage } from "#templates/admin/schema-atlas.tsx";

const handleSchemaAtlasGet = ownerPage(async (session) => {
  const [anomalies, unanswered] = await Promise.all([
    scanSchemaAnomalies(),
    listUnansweredSumupMoney(),
  ]);
  return adminSchemaAtlasPage(session, settings.theme, anomalies, unanswered);
});

export const adminHandlers = defineRoutes({
  "GET /admin/schema": handleSchemaAtlasGet,
});
