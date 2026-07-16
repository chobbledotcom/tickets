/* jscpd:ignore-start -- imports */
import { once, reduce } from "#fp";
import { withMessageGroups } from "#i18n";
import {
  ADMIN_BASE_MESSAGE_GROUPS,
  API_MESSAGE_GROUPS,
  JOIN_MESSAGE_GROUPS,
  PUBLIC_MESSAGE_GROUPS,
} from "#locales/groups.ts";
import type { MessageGroup } from "#locales/manifest.ts";
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
type PrefixRoute = {
  handler: RouterFn;
  messageGroups: readonly MessageGroup[];
};
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

const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

const prefixRoute = (
  messageGroups: readonly MessageGroup[],
  handler: RouterFn,
): PrefixRoute => ({ handler, messageGroups });

type PublicPagesModule = Awaited<ReturnType<typeof loadPublicPages>>;

type PublicGetPageSpec = {
  prefix: string;
  pick: (pages: PublicPagesModule) => ResponseHandler<[request: Request]>;
};

const PUBLIC_GET_PAGES: PublicGetPageSpec[] = [
  { pick: (pages) => pages.handleHome, prefix: "" },
  { pick: (pages) => pages.handlePublicListings, prefix: "listings" },
  { pick: (pages) => pages.handlePublicTerms, prefix: "terms" },
];

const publicPagePath = (prefix: string): string =>
  prefix === "" ? "/" : `/${prefix}`;

const publicPageHandlers = reduce(
  (handlers: Record<string, PrefixRoute>, spec: PublicGetPageSpec) => {
    const path = publicPagePath(spec.prefix);
    handlers[spec.prefix] = prefixRoute(
      PUBLIC_MESSAGE_GROUPS,
      async (request, requestPath, method) => {
        if (requestPath !== path || method !== "GET") return null;
        return spec.pick(await loadPublicPages())(request);
      },
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

const legacyEventsRedirectHandler: RouterFn = async (_request, path, method) =>
  path === "/events" && method === "GET" && settings.features.site
    ? redirectResponse("/listings")
    : null;

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
  api: prefixRoute(
    API_MESSAGE_GROUPS,
    async (request, path, method, server) => {
      const adminResult = await (await loadAdminApiRoutes())(
        request,
        path,
        method,
        server,
      );
      if (adminResult) return adminResult;
      return settings.showPublicApi
        ? (await routeLoaders.api())(request, path, method, server)
        : null;
    },
  ),
  attachment: prefixRoute([], lazyRoute(loadAttachmentRoutes)),
  calculate: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.ticket)),
  caldav: prefixRoute([], lazyRoute(routeLoaders.feed)),
  checkin: prefixRoute(
    ADMIN_BASE_MESSAGE_GROUPS,
    lazyRoute(routeLoaders.checkin),
  ),
  contact: prefixRoute(PUBLIC_MESSAGE_GROUPS, contactPrefixHandler),
  "custom.css": prefixRoute([], customCssPrefixHandler),
  demo: prefixRoute(
    ADMIN_BASE_MESSAGE_GROUPS,
    lazyRoute(routeLoaders.demoReset),
  ),
  events: prefixRoute([], legacyEventsRedirectHandler),
  feeds: prefixRoute([], lazyRoute(routeLoaders.feed)),
  gwallet: prefixRoute(
    PUBLIC_MESSAGE_GROUPS,
    lazyRoute(routeLoaders.googleWallet),
  ),
  image: prefixRoute([], lazyRoute(routeLoaders.image)),
  instance: prefixRoute([], lazyRoute(loadInstanceRoutes)),
  join: prefixRoute(JOIN_MESSAGE_GROUPS, lazyRoute(routeLoaders.join)),
  news: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.news)),
  order: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.order)),
  "order.js": prefixRoute([], orderJsPrefixHandler),
  page: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.sitePage)),
  pay: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.balance)),
  payment: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.payment)),
  "read-only": prefixRoute([], (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  ),
  renew: prefixRoute(
    PUBLIC_MESSAGE_GROUPS,
    lazyRoute(exactRouteLoaders.renewal),
  ),
  scheduled: prefixRoute(["builder"], lazyRoute(loadScheduledRoutes)),
  sms: prefixRoute([], lazyRoute(routeLoaders.smsWebhook)),
  t: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.ticketView)),
  ticket: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.ticket)),
  unsubscribe: prefixRoute(
    PUBLIC_MESSAGE_GROUPS,
    lazyRoute(exactRouteLoaders.unsubscribe),
  ),
  v1: prefixRoute(["fields"], lazyRoute(routeLoaders.walletWebservice)),
  wallet: prefixRoute(PUBLIC_MESSAGE_GROUPS, lazyRoute(routeLoaders.wallet)),
};

/** Route a request after database and settings setup have completed. */
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
  return await withMessageGroups(
    route.messageGroups,
    async () =>
      (await route.handler(request, path, method, server)) ??
      notFoundResponse(),
  );
};
