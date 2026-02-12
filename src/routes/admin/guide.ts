/**
 * Admin guide route
 */

import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, requireSessionOr } from "#routes/utils.ts";
import { adminGuidePage } from "#templates/admin/guide.tsx";

/**
 * Handle GET /admin/guide
 */
const handleAdminGuideGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, (session) =>
    htmlResponse(adminGuidePage(session)),
  );

/** Guide routes */
export const guideRoutes = defineRoutes({
  "GET /admin/guide": (request) => handleAdminGuideGet(request),
});
