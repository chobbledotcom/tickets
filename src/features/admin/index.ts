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
import { enableFooterDebug } from "#shared/db/query-log.ts";
import { isStaffRole } from "#shared/types.ts";

type RouteMap = Record<string, RouteHandlerFn>;

/** One admin area: its lazy route map plus the `/admin/<segment>` prefixes it serves. */
export type AdminArea = {
  load: () => Promise<RouteMap>;
  segments: readonly string[];
};

/** Declare an area: import its module lazily and pick the route map out of it. */
const area = <M>(
  load: () => Promise<M>,
  pick: (module: M) => RouteMap,
  segments: readonly string[],
): AdminArea => ({ load: async () => pick(await load()), segments });

// Import specifiers stay literal so esbuild can still bundle every target.
export const ADMIN_AREAS: Record<string, AdminArea> = {
  apiKeys: area(
    () => import("#routes/admin/api-keys.ts"),
    (m) => m.apiKeysRoutes,
    ["api-keys"],
  ),
  attendeeNotes: area(
    () => import("#routes/admin/attendee-notes.ts"),
    (m) => m.attendeeNotesRoutes,
    ["attendee"],
  ),
  attendeeRefunds: area(
    () => import("#routes/admin/attendee-refunds.ts"),
    (m) => m.attendeeRefundRoutes,
    ["attendees", "listing"],
  ),
  attendees: area(
    () => import("#routes/admin/attendees.ts"),
    (m) => m.attendeesRoutes,
    ["attendees", "listing"],
  ),
  attributes: area(
    () => import("#routes/admin/attributes.ts"),
    (m) => m.attributesRoutes,
    ["attributes", "listing"],
  ),
  auth: area(
    () => import("#routes/admin/auth.ts"),
    (m) => m.authRoutes,
    ["login", "logout"],
  ),
  backup: area(
    () => import("#routes/admin/backup.ts"),
    (m) => m.backupRoutes,
    ["backup"],
  ),
  builder: area(
    () => import("#routes/admin/builder.ts"),
    (m) => m.builderRoutes,
    ["builder"],
  ),
  builtSites: area(
    () => import("#routes/admin/built-sites.ts"),
    (m) => m.builtSitesRoutes,
    ["built-sites"],
  ),
  bulkActions: area(
    () => import("#routes/admin/bulk-actions.ts"),
    (m) => m.bulkActionsRoutes,
    ["groups"],
  ),
  bulkEmail: area(
    () => import("#routes/admin/bulk-email.ts"),
    (m) => m.bulkEmailRoutes,
    ["emails"],
  ),
  calendar: area(
    () => import("#routes/admin/calendar.ts"),
    (m) => m.calendarRoutes,
    ["calendar"],
  ),
  catalogTransfer: area(
    () => import("#routes/admin/catalog-transfer/routes.ts"),
    (m) => m.catalogTransferRoutes,
    ["catalog", "groups", "listing"],
  ),
  contactHistory: area(
    () => import("#routes/admin/contact-history.ts"),
    (m) => m.contactHistoryRoutes,
    ["history"],
  ),
  dashboard: area(
    () => import("#routes/admin/dashboard.ts"),
    (m) => m.dashboardRoutes,
    ["", "listings", "log"],
  ),
  debug: area(
    () => import("#routes/admin/debug.ts"),
    (m) => m.debugRoutes,
    ["debug"],
  ),
  deliveries: area(
    () => import("#routes/admin/deliveries.ts"),
    (m) => m.deliveriesRoutes,
    ["deliveries"],
  ),
  groups: area(
    () => import("#routes/admin/groups.ts"),
    (m) => m.groupsRoutes,
    ["groups"],
  ),
  guide: area(
    () => import("#routes/admin/guide.ts"),
    (m) => m.guideRoutes,
    ["formatting", "guide"],
  ),
  holidays: area(
    () => import("#routes/admin/holidays.ts"),
    (m) => m.holidaysCrud.routes,
    ["holidays"],
  ),
  images: area(
    () => import("#routes/admin/images.ts"),
    (m) => m.imagesRoutes,
    ["images"],
  ),
  ledger: area(
    () => import("#routes/admin/ledger.ts"),
    (m) => m.ledgerRoutes,
    ["ledger"],
  ),
  listingQr: area(
    () => import("#routes/admin/listing-qr.ts"),
    (m) => m.listingQrRoutes,
    ["listing"],
  ),
  listings: area(
    () => import("#routes/admin/listings.ts"),
    (m) => m.listingsRoutes,
    ["listing", "listings"],
  ),
  markdownPreview: area(
    () => import("#routes/admin/markdown-preview.ts"),
    (m) => m.markdownPreviewRoutes,
    ["markdown-preview"],
  ),
  modifiers: area(
    () => import("#routes/admin/modifiers.ts"),
    (m) => m.modifiersRoutes,
    ["modifiers"],
  ),
  news: area(
    () => import("#routes/admin/news.ts"),
    (m) => m.newsRoutes,
    ["site"],
  ),
  privacy: area(
    () => import("#routes/admin/privacy.ts"),
    (m) => m.privacyRoutes,
    ["privacy"],
  ),
  questions: area(
    () => import("#routes/admin/questions.ts"),
    (m) => m.questionsRoutes,
    ["listing", "questions"],
  ),
  scanner: area(
    () => import("#routes/admin/scanner.ts"),
    (m) => m.scannerRoutes,
    ["listing"],
  ),
  seeds: area(
    () => import("#routes/admin/seeds.ts"),
    (m) => m.seedsRoutes,
    ["seeds"],
  ),
  servicing: area(
    () => import("#routes/admin/servicing.tsx"),
    (m) => m.servicingRoutes,
    ["servicing"],
  ),
  sessions: area(
    () => import("#routes/admin/sessions.ts"),
    (m) => m.sessionsRoutes,
    ["sessions"],
  ),
  settings: area(
    () => import("#routes/admin/settings.ts"),
    (m) => m.settingsRoutes,
    ["listing-defaults", "settings", "settings-advanced"],
  ),
  settingsLogistics: area(
    () => import("#routes/admin/settings-logistics.ts"),
    (m) => m.logisticsRoutes,
    ["logistics"],
  ),
  settingsStatuses: area(
    () => import("#routes/admin/settings-statuses.ts"),
    (m) => m.attendeeStatusesRoutes,
    ["settings"],
  ),
  site: area(
    () => import("#routes/admin/site.ts"),
    (m) => m.siteRoutes,
    ["site"],
  ),
  sitePages: area(
    () => import("#routes/admin/site-pages.ts"),
    (m) => m.sitePagesRoutes,
    ["site"],
  ),
  sms: area(
    () => import("#routes/admin/sms.ts"),
    (m) => m.smsRoutes,
    ["sms"],
  ),
  support: area(
    () => import("#routes/admin/support.ts"),
    (m) => m.supportRoutes,
    ["support"],
  ),
  update: area(
    () => import("#routes/admin/update.ts"),
    (m) => m.updateRoutes,
    ["update"],
  ),
  users: area(
    () => import("#routes/admin/users.ts"),
    (m) => m.usersRoutes,
    ["user", "users"],
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
  const areasBySegment: Record<string, AdminArea[]> = {};
  for (const adminArea of Object.values(ADMIN_AREAS)) {
    for (const segment of adminArea.segments) {
      const list = areasBySegment[segment] ?? [];
      list.push(adminArea);
      areasBySegment[segment] = list;
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
