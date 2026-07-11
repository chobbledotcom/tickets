/**
 * Admin routes — a declarative manifest instead of one merged router.
 *
 * Each admin area declares how to load its route-ID handlers and which
 * `/admin/<segment>` prefixes it serves. A request loads only the areas that
 * share its segment, so the first admin hit evaluates a handful of modules
 * rather than the whole admin tree. The manifest is pure data at module load;
 * no handler code runs until a request needs it.
 *
 * GET requests are wrapped to enable SQL query logging for admin users
 * (owners and managers). The debug footer is rendered inline by the
 * Layout template when query logging is active, avoiding response body
 * re-reading which intermittently fails on Bunny Edge.
 *
 * `test/lib/admin-route-manifest.test.ts` proves every area implements exactly
 * its schema route IDs and every declared segment serves at least one route.
 */

import { once } from "#fp";
import { routeMapForArea } from "#routes/admin/handlers.ts";
import { createRouter } from "#routes/router.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import type { AdminAreaId } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { enableFooterDebug } from "#shared/db/query-log.ts";
import { isStaffRole } from "#shared/types.ts";

type HandlerMap = Record<string, (...args: never[]) => unknown>;

/** One admin area's lazy route-ID handlers. */
export type AdminAreaLoader = {
  load: () => Promise<HandlerMap>;
};

/** Declare an area without importing its handlers until that area is requested. */
const area = <M extends { adminHandlers: HandlerMap }>(
  load: () => Promise<M>,
): AdminAreaLoader => ({ load: async () => (await load()).adminHandlers });

// Import specifiers stay literal so esbuild can still bundle every target.
export const ADMIN_AREA_LOADERS: Record<AdminAreaId, AdminAreaLoader> = {
  apiKeys: area(() => import("#routes/admin/api-keys.ts")),
  attendeeNotes: area(() => import("#routes/admin/attendee-notes.ts")),
  attendeeRefunds: area(() => import("#routes/admin/attendee-refunds.ts")),
  attendees: area(() => import("#routes/admin/attendees.ts")),
  attributes: area(() => import("#routes/admin/attributes.ts")),
  auth: area(() => import("#routes/admin/auth.ts")),
  backup: area(() => import("#routes/admin/backup.ts")),
  builder: area(() => import("#routes/admin/builder.ts")),
  builtSites: area(() => import("#routes/admin/built-sites.ts")),
  bulkActions: area(() => import("#routes/admin/bulk-actions.ts")),
  bulkEmail: area(() => import("#routes/admin/bulk-email.ts")),
  calendar: area(() => import("#routes/admin/calendar.ts")),
  catalogTransfer: area(
    () => import("#routes/admin/catalog-transfer/routes.ts"),
  ),
  contactHistory: area(() => import("#routes/admin/contact-history.ts")),
  dashboard: area(() => import("#routes/admin/dashboard.ts")),
  debug: area(() => import("#routes/admin/debug.ts")),
  deliveries: area(() => import("#routes/admin/deliveries.ts")),
  groups: area(() => import("#routes/admin/groups.ts")),
  guide: area(() => import("#routes/admin/guide.ts")),
  holidays: area(() => import("#routes/admin/holidays.ts")),
  images: area(() => import("#routes/admin/images.ts")),
  ledger: area(() => import("#routes/admin/ledger.ts")),
  listingQr: area(() => import("#routes/admin/listing-qr.ts")),
  listings: area(() => import("#routes/admin/listings.ts")),
  markdownPreview: area(() => import("#routes/admin/markdown-preview.ts")),
  modifiers: area(() => import("#routes/admin/modifiers.ts")),
  news: area(() => import("#routes/admin/news.ts")),
  privacy: area(() => import("#routes/admin/privacy.ts")),
  questions: area(() => import("#routes/admin/questions.ts")),
  scanner: area(() => import("#routes/admin/scanner.ts")),
  seeds: area(() => import("#routes/admin/seeds.ts")),
  servicing: area(() => import("#routes/admin/servicing.tsx")),
  sessions: area(() => import("#routes/admin/sessions.ts")),
  settings: area(() => import("#routes/admin/settings.ts")),
  settingsLogistics: area(() => import("#routes/admin/settings-logistics.ts")),
  settingsStatuses: area(() => import("#routes/admin/settings-statuses.ts")),
  site: area(() => import("#routes/admin/site.ts")),
  sitePages: area(() => import("#routes/admin/site-pages.ts")),
  sms: area(() => import("#routes/admin/sms.ts")),
  support: area(() => import("#routes/admin/support.ts")),
  update: area(() => import("#routes/admin/update.ts")),
  users: area(() => import("#routes/admin/users.ts")),
};

/** The `/admin/<segment>` part of a path — "" for `/admin` itself. */
export const adminPathSegment = (path: string): string =>
  path.split("/")[2] ?? "";

/**
 * One lazy router per segment, derived from the manifest at module load
 * (pure and cheap — no area module is imported until its `once` fires).
 */
const buildSegmentRouters = (): Record<
  string,
  () => Promise<PathMethodRoute>
> => {
  const areasBySegment: Record<
    string,
    Array<{ id: AdminAreaId; loader: AdminAreaLoader }>
  > = {};
  for (const [id, segments] of Object.entries(ADMIN_SURFACE.areas)) {
    const loader = ADMIN_AREA_LOADERS[id as AdminAreaId];
    for (const segment of segments) {
      const list = areasBySegment[segment] ?? [];
      list.push({ id: id as AdminAreaId, loader });
      areasBySegment[segment] = list;
    }
  }
  const routers: Record<string, () => Promise<PathMethodRoute>> = {};
  for (const [segment, areas] of Object.entries(areasBySegment)) {
    routers[segment] = once(async () => {
      const maps = await Promise.all(
        areas.map(async ({ id, loader }) =>
          routeMapForArea(id, await loader.load()),
        ),
      );
      return createRouter(Object.assign({}, ...maps));
    });
  }
  return routers;
};

const segmentRouters = buildSegmentRouters();

/**
 * Route admin requests.
 * For GET requests by authenticated admins, enables query logging so the
 * Layout template renders the debug footer inline.
 */
export const routeAdmin: PathMethodRoute = async (
  request,
  path,
  method,
  server,
) => {
  // An unknown segment 404s before any session work, so probing traffic
  // never costs a session lookup.
  const segment = adminPathSegment(path);
  if (!Object.hasOwn(segmentRouters, segment)) return null;

  // Query recording is turned on earlier (prepareRequestEnvironment) for admin
  // GETs, so the route's settings load is captured. Here we only unlock the
  // footer for back-office staff — delivery agents and content editors (who are
  // excluded from operational/debug access) never see the SQL/cache debug menu.
  const { getAuthenticatedSession } = await import("#routes/auth.ts");
  const session = await getAuthenticatedSession(request);

  if (method === "GET" && session && isStaffRole(session.adminLevel)) {
    enableFooterDebug();
  }

  const router = await segmentRouters[segment]!();
  return router(request, path, method, server);
};
