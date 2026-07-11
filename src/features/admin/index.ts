/**
 * Admin routes — a declarative manifest instead of one merged router.
 *
 * Each admin area declares how to load its route map and which
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
 * `test/lib/admin-route-manifest.test.ts` proves the manifest honest both
 * ways: every route a module defines falls under one of its declared
 * segments, and every declared segment serves at least one route.
 */

import { once } from "#fp";
import { createRouter, type RouteHandlerFn } from "#routes/router.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import type { AdminAreaId } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { enableFooterDebug } from "#shared/db/query-log.ts";
import { isStaffRole } from "#shared/types.ts";

type RouteMap = Record<string, RouteHandlerFn>;

/** One admin area: its lazy route map plus the `/admin/<segment>` prefixes it serves. */
export type AdminAreaLoader = {
  load: () => Promise<RouteMap>;
};

/** Declare an area: import its module lazily and pick the route map out of it. */
const area = <M>(
  load: () => Promise<M>,
  pick: (module: M) => RouteMap,
): AdminAreaLoader => ({ load: async () => pick(await load()) });

// Import specifiers stay literal so esbuild can still bundle every target.
export const ADMIN_AREA_LOADERS: Record<AdminAreaId, AdminAreaLoader> = {
  apiKeys: area(
    () => import("#routes/admin/api-keys.ts"),
    (m) => m.apiKeysRoutes,
  ),
  attendeeNotes: area(
    () => import("#routes/admin/attendee-notes.ts"),
    (m) => m.attendeeNotesRoutes,
  ),
  attendeeRefunds: area(
    () => import("#routes/admin/attendee-refunds.ts"),
    (m) => m.attendeeRefundRoutes,
  ),
  attendees: area(
    () => import("#routes/admin/attendees.ts"),
    (m) => m.attendeesRoutes,
  ),
  attributes: area(
    () => import("#routes/admin/attributes.ts"),
    (m) => m.attributesRoutes,
  ),
  auth: area(
    () => import("#routes/admin/auth.ts"),
    (m) => m.authRoutes,
  ),
  backup: area(
    () => import("#routes/admin/backup.ts"),
    (m) => m.backupRoutes,
  ),
  builder: area(
    () => import("#routes/admin/builder.ts"),
    (m) => m.builderRoutes,
  ),
  builtSites: area(
    () => import("#routes/admin/built-sites.ts"),
    (m) => m.builtSitesRoutes,
  ),
  bulkActions: area(
    () => import("#routes/admin/bulk-actions.ts"),
    (m) => m.bulkActionsRoutes,
  ),
  bulkEmail: area(
    () => import("#routes/admin/bulk-email.ts"),
    (m) => m.bulkEmailRoutes,
  ),
  calendar: area(
    () => import("#routes/admin/calendar.ts"),
    (m) => m.calendarRoutes,
  ),
  catalogTransfer: area(
    () => import("#routes/admin/catalog-transfer/routes.ts"),
    (m) => m.catalogTransferRoutes,
  ),
  contactHistory: area(
    () => import("#routes/admin/contact-history.ts"),
    (m) => m.contactHistoryRoutes,
  ),
  dashboard: area(
    () => import("#routes/admin/dashboard.ts"),
    (m) => m.dashboardRoutes,
  ),
  debug: area(
    () => import("#routes/admin/debug.ts"),
    (m) => m.debugRoutes,
  ),
  deliveries: area(
    () => import("#routes/admin/deliveries.ts"),
    (m) => m.deliveriesRoutes,
  ),
  groups: area(
    () => import("#routes/admin/groups.ts"),
    (m) => m.groupsRoutes,
  ),
  guide: area(
    () => import("#routes/admin/guide.ts"),
    (m) => m.guideRoutes,
  ),
  holidays: area(
    () => import("#routes/admin/holidays.ts"),
    (m) => m.holidaysCrud.routes,
  ),
  images: area(
    () => import("#routes/admin/images.ts"),
    (m) => m.imagesRoutes,
  ),
  ledger: area(
    () => import("#routes/admin/ledger.ts"),
    (m) => m.ledgerRoutes,
  ),
  listingQr: area(
    () => import("#routes/admin/listing-qr.ts"),
    (m) => m.listingQrRoutes,
  ),
  listings: area(
    () => import("#routes/admin/listings.ts"),
    (m) => m.listingsRoutes,
  ),
  markdownPreview: area(
    () => import("#routes/admin/markdown-preview.ts"),
    (m) => m.markdownPreviewRoutes,
  ),
  modifiers: area(
    () => import("#routes/admin/modifiers.ts"),
    (m) => m.modifiersRoutes,
  ),
  news: area(
    () => import("#routes/admin/news.ts"),
    (m) => m.newsRoutes,
  ),
  privacy: area(
    () => import("#routes/admin/privacy.ts"),
    (m) => m.privacyRoutes,
  ),
  questions: area(
    () => import("#routes/admin/questions.ts"),
    (m) => m.questionsRoutes,
  ),
  scanner: area(
    () => import("#routes/admin/scanner.ts"),
    (m) => m.scannerRoutes,
  ),
  seeds: area(
    () => import("#routes/admin/seeds.ts"),
    (m) => m.seedsRoutes,
  ),
  servicing: area(
    () => import("#routes/admin/servicing.tsx"),
    (m) => m.servicingRoutes,
  ),
  sessions: area(
    () => import("#routes/admin/sessions.ts"),
    (m) => m.sessionsRoutes,
  ),
  settings: area(
    () => import("#routes/admin/settings.ts"),
    (m) => m.settingsRoutes,
  ),
  settingsLogistics: area(
    () => import("#routes/admin/settings-logistics.ts"),
    (m) => m.logisticsRoutes,
  ),
  settingsStatuses: area(
    () => import("#routes/admin/settings-statuses.ts"),
    (m) => m.attendeeStatusesRoutes,
  ),
  site: area(
    () => import("#routes/admin/site.ts"),
    (m) => m.siteRoutes,
  ),
  sitePages: area(
    () => import("#routes/admin/site-pages.ts"),
    (m) => m.sitePagesRoutes,
  ),
  sms: area(
    () => import("#routes/admin/sms.ts"),
    (m) => m.smsRoutes,
  ),
  support: area(
    () => import("#routes/admin/support.ts"),
    (m) => m.supportRoutes,
  ),
  update: area(
    () => import("#routes/admin/update.ts"),
    (m) => m.updateRoutes,
  ),
  users: area(
    () => import("#routes/admin/users.ts"),
    (m) => m.usersRoutes,
  ),
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
  const areasBySegment: Record<string, AdminAreaLoader[]> = {};
  for (const [id, segments] of Object.entries(ADMIN_SURFACE.areas)) {
    const loader = ADMIN_AREA_LOADERS[id as AdminAreaId];
    for (const segment of segments) {
      (areasBySegment[segment] ??= []).push(loader);
    }
  }
  const routers: Record<string, () => Promise<PathMethodRoute>> = {};
  for (const [segment, areas] of Object.entries(areasBySegment)) {
    routers[segment] = once(async () => {
      const maps = await Promise.all(areas.map(({ load }) => load()));
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
