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
import { requireAdminApiOr } from "#routes/auth.ts";
import {
  htmlResponse,
  jsonResponse,
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
  messageGroups: readonly MessageGroup[],
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
  api: (): Response => jsonResponse({ error: READ_ONLY_MESSAGE }, 403),
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

// Import specifiers stay literal so esbuild can bundle every lazy target.
const routeLoaders = {
  admin: lazyExport(() => import("#routes/admin/index.ts"), "routeAdmin"),
  api: lazyExport(() => import("#routes/api/index.ts"), "routeApi"),
  balance: lazyExport(
    () => import("#routes/public/balance.ts"),
    "routeBalance",
  ),
  checkin: lazyExport(() => import("#routes/checkin.ts"), "routeCheckin"),
  demoReset: lazyExport(
    () => import("#routes/admin/database-reset.ts"),
    "routeDatabaseReset",
  ),
  feed: lazyExport(() => import("#routes/feeds.ts"), "routeFeed"),
  googleWallet: lazyExport(
    () => import("#routes/wallet/google.ts"),
    "routeGoogleWallet",
  ),
  image: lazyExport(() => import("#routes/images.ts"), "routeImage"),
  join: lazyExport(() => import("#routes/join.ts"), "routeJoin"),
  news: lazyExport(() => import("#routes/public/news.ts"), "routeNews"),
  order: lazyExport(() => import("#routes/public/order.ts"), "routeOrder"),
  payment: lazyExport(() => import("#routes/api/webhooks.ts"), "routePayment"),
  sitePage: lazyExport(
    () => import("#routes/public/site-page.ts"),
    "routeSitePage",
  ),
  smsWebhook: lazyExport(
    () => import("#routes/api/sms-webhook.ts"),
    "routeSmsWebhook",
  ),
  ticket: lazyExport(
    () => import("#routes/public/ticket-routes.ts"),
    "routeTicket",
  ),
  ticketView: lazyExport(
    () => import("#routes/tickets/index.ts"),
    "routeTicketView",
  ),
  wallet: lazyExport(() => import("#routes/wallet/index.ts"), "routeWallet"),
  walletWebservice: lazyExport(
    () => import("#routes/wallet/webservice.ts"),
    "routeWalletWebservice",
  ),
};

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

const loadPublicPages = once(() => import("#routes/public/pages.ts"));

const loadAttachmentRoutes = once(async () =>
  createRouter((await import("#routes/attachments.ts")).attachmentRoutes),
);

const loadAdminApiRoutes = once(async () =>
  createRouter((await import("#routes/admin/api.ts")).adminApiRoutes),
);

const loadScheduledRoutes = once(async () =>
  createRouter((await import("#routes/scheduled.ts")).scheduledRoutes),
);

const loadInstanceRoutes = once(async () =>
  createRouter((await import("#routes/instance.ts")).instanceRoutes),
);

const exactRouteLoaders = {
  addressLookup: lazyRouter(
    () => import("#routes/public/address-lookup.ts"),
    ({ handleAddressLookupGet }) =>
      defineRoutes({ "GET /address-lookup": handleAddressLookupGet }),
  ),
  renewal: lazyRouter(
    () => import("#routes/public/renewal.ts"),
    ({ handleRenewalGet, handleRenewalPost }) =>
      defineRoutes({
        "GET /renew": handleRenewalGet,
        "POST /renew": handleRenewalPost,
      }),
  ),
  unsubscribe: lazyRouter(
    () => import("#routes/public/unsubscribe.ts"),
    ({ handleUnsubscribeGet, handleUnsubscribePost }) =>
      defineRoutes({
        "GET /unsubscribe": handleUnsubscribeGet,
        "POST /unsubscribe": handleUnsubscribePost,
      }),
  ),
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

const prefixHandlers: Record<string, PrefixRoute> = {
  ...publicPageHandlers,
  "address-lookup": prefixRoute(
    ["address-lookup"],
    lazyRoute(exactRouteLoaders.addressLookup),
  ),
  admin: prefixRoute([], lazyRoute(routeLoaders.admin)),
  api: prefixRoute([], async (request, path, method, server) => {
    if (path.startsWith("/api/admin/")) {
      return await requireAdminApiOr(request, () =>
        withMessageGroups(ADMIN_API_MESSAGE_GROUPS, async () =>
          (await loadAdminApiRoutes())(request, path, method, server),
        ),
      );
    }
    return settings.showPublicApi
      ? withMessageGroups(PUBLIC_API_MESSAGE_GROUPS, async () =>
          (await routeLoaders.api())(request, path, method, server),
        )
      : null;
  }),
  attachment: prefixRoute([], lazyRoute(loadAttachmentRoutes)),
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
  instance: prefixRoute([], lazyRoute(loadInstanceRoutes)),
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
    lazyRoute(exactRouteLoaders.renewal),
  ),
  scheduled: prefixRoute([], lazyRoute(loadScheduledRoutes)),
  sms: prefixRoute([], lazyRoute(routeLoaders.smsWebhook)),
  t: prefixRoute(
    publicMessageGroups("listing-qr", "payment", "tickets"),
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
    lazyRoute(exactRouteLoaders.unsubscribe),
  ),
  v1: prefixRoute(["tickets"], lazyRoute(routeLoaders.walletWebservice)),
  wallet: prefixRoute(
    publicMessageGroups("tickets"),
    lazyRoute(routeLoaders.wallet),
  ),
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
