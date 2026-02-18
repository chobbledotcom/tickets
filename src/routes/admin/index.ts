/**
 * Admin routes - combined from individual route modules
 *
 * GET requests are wrapped to track SQL queries and inject an
 * owner-only debug footer showing render time and query details.
 */

import { disableQueryLog, enableQueryLog, getQueryLog } from "#lib/db/query-log.ts";
import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { eventsRoutes } from "#routes/admin/events.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { createRouter } from "#routes/router.ts";
import { getAuthenticatedSession } from "#routes/utils.ts";
import { ownerFooterHtml } from "#templates/admin/footer.tsx";

/** Combined admin routes */
const adminRoutes = {
  ...dashboardRoutes,
  ...authRoutes,
  ...settingsRoutes,
  ...sessionsRoutes,
  ...calendarRoutes,
  ...eventsRoutes,
  ...attendeesRoutes,
  ...usersRoutes,
  ...guideRoutes,
  ...groupsRoutes,
  ...holidaysRoutes,
  ...scannerRoutes,
};

const innerRouter = createRouter(adminRoutes);

type RouterFn = ReturnType<typeof createRouter>;

/**
 * Route admin requests.
 * For GET requests, enables query tracking and injects the owner debug
 * footer into HTML responses when the authenticated user is an owner.
 */
export const routeAdmin: RouterFn = async (request, path, method, server) => {
  if (method !== "GET") {
    return innerRouter(request, path, method, server);
  }

  // Check owner status before tracking so the auth queries aren't logged
  const session = await getAuthenticatedSession(request);
  const isOwner = session?.adminLevel === "owner";

  if (isOwner) enableQueryLog();
  const startTime = performance.now();

  try {
    const response = await innerRouter(request, path, method, server);
    if (!response) return null;
    if (!isOwner) return response;

    if (response.status !== 200) return response;
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("text/html")) return response;

    const html = await response.text();
    const footer = ownerFooterHtml(
      performance.now() - startTime,
      getQueryLog(),
    );
    return new Response(html.replace("</body>", footer + "</body>"), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    if (isOwner) disableQueryLog();
  }
};
