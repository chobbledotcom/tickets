/**
 * Admin routes - combined from individual route modules
 */

import { createRouter } from "../router.ts";
import { attendeesRoutes } from "./attendees.ts";
import { authRoutes } from "./auth.ts";
import { dashboardRoutes } from "./dashboard.ts";
import { eventsRoutes } from "./events.ts";
import { sessionsRoutes } from "./sessions.ts";
import { settingsRoutes } from "./settings.ts";

/** Combined admin routes */
const adminRoutes = {
  ...dashboardRoutes,
  ...authRoutes,
  ...settingsRoutes,
  ...sessionsRoutes,
  ...eventsRoutes,
  ...attendeesRoutes,
};

/** Route admin requests using declarative router */
export const routeAdmin = createRouter(adminRoutes);
