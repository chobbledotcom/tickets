/**
 * Admin routes - combined from individual route modules
 */

import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { eventsRoutes } from "#routes/admin/events.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { createRouter } from "#routes/router.ts";

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
  ...holidaysRoutes,
};

/** Route admin requests using declarative router */
export const routeAdmin = createRouter(adminRoutes);
