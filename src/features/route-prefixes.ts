import { reduce } from "#fp";
import { withMessageGroups } from "#i18n";
import {
  ADMIN_API_MESSAGE_GROUPS,
  ADMIN_SHELL_MESSAGE_GROUPS,
  JOIN_MESSAGE_GROUPS,
  PUBLIC_API_MESSAGE_GROUPS,
  publicMessageGroups,
} from "#locales/groups.ts";
import type { MessageGroup } from "#locales/manifest.ts";
import { requireAdminApiOr } from "#routes/auth.ts";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { type RouterFn, routeLoaders } from "#routes/route-loaders.ts";
import { getPrefix } from "#routes/settings-bundles.ts";
import { readOnlyGetRoutePatterns } from "#shared/admin-pages.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { settings } from "#shared/db/settings.ts";
import { isReadOnly } from "#shared/env.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { readOnlyPage } from "#templates/public/errors.tsx";

/** Create a lazy-loaded route handler (prefix already matched by dispatch map). */
const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

type PrefixRoute = {
  beforeMessages: (path: string, method: string) => Response | null;
  handler: RouterFn;
  messageGroups: readonly MessageGroup[];
};

const continueRoute = (_path: string, _method: string): null => null;

const prefixRoute = (
  messageGroups: readonly MessageGroup[],
  handler: RouterFn,
  beforeMessages: PrefixRoute["beforeMessages"] = continueRoute,
): PrefixRoute => ({ beforeMessages, handler, messageGroups });

const disabledPublicSiteGet = (
  _path: string,
  method: string,
): Response | null =>
  method === "GET" && !settings.showPublicSite
    ? redirectResponse("/admin/login")
    : null;

const requirePublicSiteGet =
  (expectedPath: string) =>
  (path: string, method: string): Response | null =>
    path === expectedPath ? disabledPublicSiteGet(path, method) : null;

/** Read-only mode message. */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

/** GET create/edit/delete/duplicate form pages blocked in read-only mode. */
const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

const READ_ONLY_ADMIN_OPERATIONS = ADMIN_SURFACE.routes
  .filter((route) => route.method !== "GET" && route.readOnly === "allow")
  .map((route) => ({
    method: route.method,
    pattern: routePathPatternToRegex(route.pattern),
  }));

const isMutatingMethod = (method: string): boolean =>
  method === "DELETE" ||
  method === "PATCH" ||
  method === "POST" ||
  method === "PUT";

const isAdminMutation = (path: string, method: string): boolean =>
  isMutatingMethod(method) && (path === "/admin" || path.startsWith("/admin/"));

const isAllowedAdminOperation = (path: string, method: string): boolean =>
  READ_ONLY_ADMIN_OPERATIONS.some(
    (route) => route.method === method && route.pattern.test(path),
  );

/** Paths that remain writable in read-only mode (default-deny allowlist). */
const READ_ONLY_SAFE_PATHS = [
  /^\/renew$/,
  /^\/pay\/[^/]+$/,
  /^\/payment\/webhook$/,
  /^\/v1\/devices\/[^/]+\/registrations\/[^/]+\/[^/]+$/,
  /^\/v1\/log$/,
  /^\/sms\/webhook$/,
  /^\/join\/[^/]+$/,
  /^\/unsubscribe$/,
  /^\/contact$/,
  /^\/instance\/site-credentials$/,
  /^\/scheduled$/,
  /^\/checkin\/[^/]+$/,
];

/** Return the read-only response, or null when the request may continue. */
const readOnlyGuard = (path: string, method: string): Response | null => {
  if (!isReadOnly()) return null;

  if (path.startsWith("/api/") && isMutatingMethod(method)) {
    return jsonResponse({ error: READ_ONLY_MESSAGE }, 403);
  }

  if (method === "GET") {
    for (const pattern of READ_ONLY_GET_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
  }

  if (isAdminMutation(path, method)) {
    return isAllowedAdminOperation(path, method)
      ? null
      : redirectResponse("/read-only");
  }

  if (isMutatingMethod(method)) {
    if (READ_ONLY_SAFE_PATHS.some((pattern) => pattern.test(path))) return null;
    return redirectResponse("/read-only");
  }

  return null;
};

type PublicPagesModule = Awaited<
  ReturnType<(typeof routeLoaders)["publicPages"]>
>;

type PublicGetPageSpec = {
  messageGroups: readonly MessageGroup[];
  prefix: string;
  pick: (pages: PublicPagesModule) => ResponseHandler<[request: Request]>;
};

const PUBLIC_GET_PAGES: PublicGetPageSpec[] = [
  {
    messageGroups: publicMessageGroups("public-site"),
    pick: (pages) => pages.handleHome,
    prefix: "",
  },
  {
    messageGroups: publicMessageGroups(
      "attributes",
      "availability",
      "public-site",
      "tickets",
    ),
    pick: (pages) => pages.handlePublicListings,
    prefix: "listings",
  },
  {
    messageGroups: publicMessageGroups("public-site"),
    pick: (pages) => pages.handlePublicTerms,
    prefix: "terms",
  },
];

const publicPagePath = (prefix: string): string =>
  prefix === "" ? "/" : `/${prefix}`;

const publicPageHandlers = reduce(
  (routes: Record<string, PrefixRoute>, spec: PublicGetPageSpec) => {
    const { messageGroups, prefix, pick } = spec;
    const path = publicPagePath(prefix);
    routes[prefix] = prefixRoute(
      messageGroups,
      async (request, requestPath, method) => {
        if (requestPath !== path || method !== "GET") return null;
        return pick(await routeLoaders.publicPages())(request);
      },
      requirePublicSiteGet(path),
    );
    return routes;
  },
  {},
)(PUBLIC_GET_PAGES);

const contactPrefixHandler: RouterFn = async (request, path, method) => {
  if (path !== "/contact") return null;
  const pages = await routeLoaders.publicPages();
  if (method === "GET") return pages.handlePublicContact(request);
  if (method === "POST") return pages.handlePublicContactSubmit(request);
  return null;
};

const legacyEventsRedirectHandler: RouterFn = async (
  _request,
  path,
  method,
) => {
  if (path !== "/events" || method !== "GET" || !settings.showPublicSite) {
    return null;
  }
  return redirectResponse("/listings");
};

const orderJsPrefixHandler: RouterFn = async (request, path, method) => {
  if (path !== "/order.js" || method !== "GET") return null;
  return (await routeLoaders.orderJs())(request);
};

const customCssPrefixHandler: RouterFn = async (_request, path, method) => {
  if (path !== "/custom.css" || method !== "GET") return null;
  return (await routeLoaders.customCss())();
};

/** Message-aware prefix dispatch table. */
const prefixHandlers: Record<string, PrefixRoute> = {
  ...publicPageHandlers,
  "address-lookup": prefixRoute(
    ["address-lookup"],
    lazyRoute(routeLoaders.addressLookup),
  ),
  admin: prefixRoute([], lazyRoute(routeLoaders.admin)),
  api: prefixRoute([], async (request, path, method, server) => {
    if (path.startsWith("/api/admin/")) {
      return await requireAdminApiOr(request, () =>
        withMessageGroups(ADMIN_API_MESSAGE_GROUPS, async () =>
          (await routeLoaders.adminApi())(request, path, method, server),
        ),
      );
    }
    return settings.showPublicApi
      ? withMessageGroups(PUBLIC_API_MESSAGE_GROUPS, async () =>
          (await routeLoaders.api())(request, path, method, server),
        )
      : null;
  }),
  attachment: prefixRoute([], lazyRoute(routeLoaders.attachment)),
  calculate: prefixRoute(
    publicMessageGroups("payment", "tickets", "validation"),
    lazyRoute(routeLoaders.ticket),
  ),
  caldav: prefixRoute([], lazyRoute(routeLoaders.feed)),
  checkin: prefixRoute(
    [
      ...ADMIN_SHELL_MESSAGE_GROUPS,
      "attendees",
      "check-in",
      "listing-qr",
      "validation",
    ],
    lazyRoute(routeLoaders.checkin),
  ),
  contact: prefixRoute(
    publicMessageGroups("contact", "public-site", "validation"),
    contactPrefixHandler,
    requirePublicSiteGet("/contact"),
  ),
  "custom.css": prefixRoute([], customCssPrefixHandler),
  demo: prefixRoute(
    [...ADMIN_SHELL_MESSAGE_GROUPS, "login", "settings", "validation"],
    lazyRoute(routeLoaders.demoReset),
  ),
  events: prefixRoute([], legacyEventsRedirectHandler),
  feeds: prefixRoute([], lazyRoute(routeLoaders.feed)),
  gwallet: prefixRoute(
    publicMessageGroups("tickets"),
    lazyRoute(routeLoaders.googleWallet),
  ),
  image: prefixRoute([], lazyRoute(routeLoaders.image)),
  instance: prefixRoute([], lazyRoute(routeLoaders.instance)),
  join: prefixRoute(JOIN_MESSAGE_GROUPS, lazyRoute(routeLoaders.join)),
  news: prefixRoute(
    publicMessageGroups("news", "public-site"),
    lazyRoute(routeLoaders.news),
    disabledPublicSiteGet,
  ),
  order: prefixRoute(
    publicMessageGroups(
      "availability",
      "capacity",
      "date-picker",
      "modifiers",
      "order",
      "public-site",
      "tickets",
      "validation",
    ),
    lazyRoute(routeLoaders.order),
  ),
  "order.js": prefixRoute([], orderJsPrefixHandler),
  page: prefixRoute(
    publicMessageGroups("public-site", "site-pages"),
    lazyRoute(routeLoaders.sitePage),
    disabledPublicSiteGet,
  ),
  pay: prefixRoute(
    publicMessageGroups("ledger", "payment", "tickets", "validation"),
    lazyRoute(routeLoaders.balance),
  ),
  payment: prefixRoute(
    ["payment", "validation"],
    lazyRoute(routeLoaders.payment),
  ),
  "read-only": prefixRoute([], (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  ),
  renew: prefixRoute(
    publicMessageGroups(
      "address-lookup",
      "payment",
      "public-site",
      "renewal",
      "tickets",
      "validation",
    ),
    lazyRoute(routeLoaders.renewal),
  ),
  scheduled: prefixRoute([], lazyRoute(routeLoaders.scheduled)),
  sms: prefixRoute([], lazyRoute(routeLoaders.smsWebhook)),
  t: prefixRoute(
    publicMessageGroups("payment", "tickets"),
    lazyRoute(routeLoaders.ticketView),
  ),
  ticket: prefixRoute(
    publicMessageGroups(
      "address-lookup",
      "availability",
      "date-picker",
      "modifiers",
      "order",
      "payment",
      "public-site",
      "questions",
      "tickets",
      "validation",
    ),
    lazyRoute(routeLoaders.ticket),
  ),
  unsubscribe: prefixRoute(
    publicMessageGroups("unsubscribe", "validation"),
    lazyRoute(routeLoaders.unsubscribe),
  ),
  v1: prefixRoute(["tickets"], lazyRoute(routeLoaders.walletWebservice)),
  wallet: prefixRoute(
    publicMessageGroups("tickets"),
    lazyRoute(routeLoaders.wallet),
  ),
};

/** Route main application requests after setup is complete. */
export const routeMainApp: RouterFn = async (request, path, method, server) => {
  const blocked = readOnlyGuard(path, method);
  if (blocked) return blocked;

  const prefix = getPrefix(path);
  const route = Object.hasOwn(prefixHandlers, prefix)
    ? prefixHandlers[prefix]
    : undefined;
  if (!route) return notFoundResponse();
  const earlyResponse = route.beforeMessages(path, method);
  if (earlyResponse) return earlyResponse;
  return await withMessageGroups(
    route.messageGroups,
    async () =>
      (await route.handler(request, path, method, server)) ??
      notFoundResponse(),
  );
};
