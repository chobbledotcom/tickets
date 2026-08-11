/* jscpd:ignore-start -- imports */
import { once, reduce } from "#fp";
import { withMessageGroups } from "#i18n";
import {
  ADMIN_API_MESSAGE_GROUPS,
  ADMIN_SHELL_MESSAGE_GROUPS,
  JOIN_MESSAGE_GROUPS,
  PUBLIC_API_MESSAGE_GROUPS,
  publicMessageGroups,
} from "#locales/groups.ts";
import type { MessageGroup } from "#locales/manifest.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import {
  createRouter,
  defineRoutes,
  type RouteHandlerFn,
} from "#routes/router.ts";
import { getPrefix } from "#routes/settings-bundles.ts";
import type { PathMethodRoute, ServerContext } from "#routes/types.ts";
import { settings } from "#shared/db/settings.ts";
import { isReadOnly } from "#shared/env.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { readOnlyPage } from "#templates/public/errors.tsx";
import { readOnlyBlock } from "./read-only.ts";

/* jscpd:ignore-end */

type RouterFn = ReturnType<typeof createRouter>;
type CompletePathMethodRoute = (
  ...args: Parameters<PathMethodRoute>
) => Promise<Response>;

type AppRouteRequest = {
  method: string;
  path: string;
  request: Request;
  server: ServerContext | undefined;
};

/** Give complete app routes one named request value instead of four arguments. */
export const defineAppRoute =
  (
    handle: (route: AppRouteRequest) => Promise<Response>,
  ): CompletePathMethodRoute =>
  (request, path, method, server) =>
    handle({ method, path, request, server });

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
  messageGroups: readonly MessageGroup[] = [],
  handler: RouterFn,
  beforeMessages: PrefixRoute["beforeMessages"] = continueRoute,
): PrefixRoute => ({ beforeMessages, handler, messageGroups });

const disabledPublicSiteGet = (
  _path: string,
  method: string,
): Response | null =>
  method === "GET" && !settings.features.site
    ? redirectResponse("/admin/login")
    : null;

const requirePublicSiteGet =
  (expectedPath: string) =>
  (path: string, method: string): Response | null =>
    path === expectedPath ? disabledPublicSiteGet(path, method) : null;

/** Read-only mode message. */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

const readOnlyResponses = {
  api: (): Response => apiErrorResponse(READ_ONLY_MESSAGE, 403),
  page: (): Response => redirectResponse("/read-only"),
} as const;

/** Lazily import a module once and pick one export from it. */
const lazyExport = <M, K extends keyof M>(
  load: () => Promise<M>,
  key: K,
): (() => Promise<M[K]>) => once(async () => (await load())[key]);

/** Lazy-load a small route table assembled from named handlers. */
const lazyRouter = <M>(
  load: () => Promise<M>,
  routes: (module: M) => Record<string, RouteHandlerFn>,
): (() => Promise<RouterFn>) =>
  once(async () => createRouter(routes(await load())));

// Handlers loaded on demand by the custom prefix handlers below (not lazy
// prefix routers, so they stay out of the LAZY_PREFIXES table).
const loadPublicPages = once(() => import("#routes/public/pages.ts"));

const loadAdminApiRoutes = lazyRouter(
  () => import("#routes/admin/api.ts"),
  ({ adminApiRoutes }) => adminApiRoutes,
);

const handlerLoaders = {
  customCss: lazyExport(
    () => import("#routes/public/custom-css.ts"),
    "handleCustomCss",
  ),
  orderJs: lazyExport(
    () => import("#routes/public/order-js.ts"),
    "handleOrderJs",
  ),
};

// prefix -> the module loaded when its URL prefix is first matched. Import
// specifiers stay literal so esbuild can bundle every lazy target into the
// single edge file while still deferring its evaluation until first matched.
const feedLoader = lazyExport(() => import("#routes/feeds.ts"), "routeFeed");

const PREFIX_LOADERS: Record<string, () => Promise<RouterFn>> = {
  "address-lookup": lazyRouter(
    () => import("#routes/public/address-lookup.ts"),
    ({ handleAddressLookupGet }) =>
      defineRoutes({ "GET /address-lookup": handleAddressLookupGet }),
  ),
  admin: lazyExport(() => import("#routes/admin/index.ts"), "routeAdmin"),
  attachment: lazyRouter(
    () => import("#routes/attachments.ts"),
    ({ attachmentRoutes }) => attachmentRoutes,
  ),
  calculate: lazyExport(
    () => import("#routes/public/ticket-routes.ts"),
    "routeTicket",
  ),
  caldav: feedLoader,
  checkin: lazyExport(() => import("#routes/checkin.ts"), "routeCheckin"),
  demo: lazyExport(
    () => import("#routes/admin/database-reset.ts"),
    "routeDatabaseReset",
  ),
  feeds: feedLoader,
  gwallet: lazyExport(
    () => import("#routes/wallet/google.ts"),
    "routeGoogleWallet",
  ),
  image: lazyExport(() => import("#routes/images.ts"), "routeImage"),
  instance: lazyRouter(
    () => import("#routes/instance.ts"),
    ({ instanceRoutes }) => instanceRoutes,
  ),
  join: lazyExport(() => import("#routes/join.ts"), "routeJoin"),
  news: lazyExport(() => import("#routes/public/news.ts"), "routeNews"),
  order: lazyExport(() => import("#routes/public/order.ts"), "routeOrder"),
  page: lazyExport(
    () => import("#routes/public/site-page.ts"),
    "routeSitePage",
  ),
  pay: lazyExport(() => import("#routes/public/balance.ts"), "routeBalance"),
  payment: lazyExport(() => import("#routes/api/webhooks.ts"), "routePayment"),
  renew: lazyRouter(
    () => import("#routes/public/renewal.ts"),
    ({ handleRenewalGet, handleRenewalPost }) =>
      defineRoutes({
        "GET /renew": handleRenewalGet,
        "POST /renew": handleRenewalPost,
      }),
  ),
  sms: lazyExport(
    () => import("#routes/api/sms-webhook.ts"),
    "routeSmsWebhook",
  ),
  t: lazyExport(() => import("#routes/tickets/index.ts"), "routeTicketView"),
  ticket: lazyExport(
    () => import("#routes/public/ticket-routes.ts"),
    "routeTicket",
  ),
  unsubscribe: lazyRouter(
    () => import("#routes/public/unsubscribe.ts"),
    ({ handleUnsubscribeGet, handleUnsubscribePost }) =>
      defineRoutes({
        "GET /unsubscribe": handleUnsubscribeGet,
        "POST /unsubscribe": handleUnsubscribePost,
      }),
  ),
  v1: lazyExport(
    () => import("#routes/wallet/webservice.ts"),
    "routeWalletWebservice",
  ),
  wallet: lazyExport(() => import("#routes/wallet/index.ts"), "routeWallet"),
};

// prefix -> the message-group bundle its handlers render. Prefixes absent here
// (admin, image, sms, feeds, ...) render no route-specific groups.
const PREFIX_MESSAGE_GROUPS: Record<string, readonly MessageGroup[]> = {
  "address-lookup": ["address-lookup"],
  calculate: publicMessageGroups("payment", "tickets", "validation"),
  checkin: [
    ...ADMIN_SHELL_MESSAGE_GROUPS,
    "attendees",
    "check-in",
    "listing-qr",
    "validation",
  ],
  demo: [...ADMIN_SHELL_MESSAGE_GROUPS, "login", "settings", "validation"],
  gwallet: publicMessageGroups("tickets"),
  join: JOIN_MESSAGE_GROUPS,
  news: publicMessageGroups("news", "public-site"),
  order: publicMessageGroups(
    "availability",
    "capacity",
    "date-picker",
    "modifiers",
    "order",
    "public-site",
    "tickets",
    "validation",
  ),
  page: publicMessageGroups("public-site", "site-pages"),
  pay: publicMessageGroups("ledger", "payment", "tickets", "validation"),
  payment: ["payment", "validation"],
  renew: publicMessageGroups(
    "address-lookup",
    "payment",
    "public-site",
    "renewal",
    "tickets",
    "validation",
  ),
  t: publicMessageGroups("listing-qr", "payment", "tickets"),
  ticket: publicMessageGroups(
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
  unsubscribe: publicMessageGroups("unsubscribe", "validation"),
  v1: ["tickets"],
  wallet: publicMessageGroups("tickets"),
};

// prefix -> a gate that can answer before message groups load (e.g. redirect a
// GET to login when the public site is off). Prefixes absent here never gate.
const PREFIX_GATES: Record<string, PrefixRoute["beforeMessages"]> = {
  news: disabledPublicSiteGet,
  page: disabledPublicSiteGet,
};

type PublicPagesModule = Awaited<ReturnType<typeof loadPublicPages>>;

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
  (handlers: Record<string, PrefixRoute>, spec: PublicGetPageSpec) => {
    const path = publicPagePath(spec.prefix);
    handlers[spec.prefix] = prefixRoute(
      spec.messageGroups,
      async (request, requestPath, method) => {
        if (requestPath !== path || method !== "GET") return null;
        return spec.pick(await loadPublicPages())(request);
      },
      requirePublicSiteGet(path),
    );
    return handlers;
  },
  {},
)(PUBLIC_GET_PAGES);

const contactPrefixHandler: RouterFn = async (request, path, method) => {
  if (path !== "/contact") return null;
  const pages = await loadPublicPages();
  if (method === "GET") return pages.handlePublicContact(request);
  if (method === "POST") return pages.handlePublicContactSubmit(request);
  return null;
};

const legacyEventsRedirectHandler: RouterFn = async (
  _request,
  path,
  method,
) => {
  if (path !== "/events" || method !== "GET" || !settings.features.site) {
    return null;
  }
  return redirectResponse("/listings");
};

const orderJsPrefixHandler: RouterFn = async (request, path, method) => {
  if (path !== "/order.js" || method !== "GET") return null;
  return (await handlerLoaders.orderJs())(request);
};

const customCssPrefixHandler: RouterFn = async (_request, path, method) => {
  if (path !== "/custom.css" || method !== "GET") return null;
  return (await handlerLoaders.customCss())();
};

const apiPrefixHandler: RouterFn = async (request, path, method, server) => {
  if (path.startsWith("/api/admin/")) {
    const { requireAdminApiOr } = await import("#routes/auth.ts");
    return await requireAdminApiOr(request, () =>
      withMessageGroups(ADMIN_API_MESSAGE_GROUPS, async () =>
        (await loadAdminApiRoutes())(request, path, method, server),
      ),
    );
  }
  return settings.showPublicApi
    ? withMessageGroups(PUBLIC_API_MESSAGE_GROUPS, async () =>
        (await import("#routes/api/index.ts")).routeApi(
          request,
          path,
          method,
          server,
        ),
      )
    : null;
};

const readOnlyInfoHandler: RouterFn = (_request, path, method) =>
  path === "/read-only" && method === "GET"
    ? Promise.resolve(htmlResponse(readOnlyPage()))
    : Promise.resolve(null);

/** Build each prefix's dispatchable route from its loader, groups, and gate. */
const lazyPrefixHandlers: Record<string, PrefixRoute> = Object.fromEntries(
  Object.entries(PREFIX_LOADERS).map(([prefix, loader]) => [
    prefix,
    prefixRoute(
      PREFIX_MESSAGE_GROUPS[prefix],
      lazyRoute(loader),
      PREFIX_GATES[prefix],
    ),
  ]),
);

const prefixHandlers: Record<string, PrefixRoute> = {
  ...publicPageHandlers,
  ...lazyPrefixHandlers,
  api: prefixRoute([], apiPrefixHandler),
  contact: prefixRoute(
    publicMessageGroups("contact", "public-site", "validation"),
    contactPrefixHandler,
    requirePublicSiteGet("/contact"),
  ),
  "custom.css": prefixRoute([], customCssPrefixHandler),
  events: prefixRoute([], legacyEventsRedirectHandler),
  "order.js": prefixRoute([], orderJsPrefixHandler),
  "read-only": prefixRoute([], readOnlyInfoHandler),
};

/** Route main application requests after setup is complete. */
export const routeMainApp = async ({
  request,
  path,
  method,
  server,
}: AppRouteRequest): Promise<Response> => {
  if (isReadOnly()) {
    const blocked = readOnlyBlock(path, method);
    if (blocked) return readOnlyResponses[blocked]();
  }

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
