import { once } from "#fp";
import {
  createRouter,
  defineRoutes,
  type RouteHandlerFn,
} from "#routes/router.ts";
import { settings } from "#shared/db/settings.ts";

export type RouterFn = ReturnType<typeof createRouter>;

/**
 * Lazily import a module once and pick a single export from it.
 * Import specifiers must stay literal so esbuild can bundle them.
 */
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

// Route groups stay lazy so the edge script only pays for what a request uses.
// Import specifiers stay literal so esbuild can still bundle every target.
export const routeLoaders = {
  addressLookup: lazyRouter(
    () => import("#routes/public/address-lookup.ts"),
    ({ handleAddressLookupGet }) =>
      defineRoutes({ "GET /address-lookup": handleAddressLookupGet }),
  ),
  admin: lazyExport(() => import("#routes/admin/index.ts"), "routeAdmin"),
  adminApi: once(async () =>
    createRouter((await import("#routes/admin/api.ts")).adminApiRoutes),
  ),
  api: lazyExport(() => import("#routes/api/index.ts"), "routeApi"),
  attachment: once(async () =>
    createRouter((await import("#routes/attachments.ts")).attachmentRoutes),
  ),
  balance: lazyExport(
    () => import("#routes/public/balance.ts"),
    "routeBalance",
  ),
  checkin: lazyExport(() => import("#routes/checkin.ts"), "routeCheckin"),
  customCss: lazyExport(
    () => import("#routes/public/custom-css.ts"),
    "handleCustomCss",
  ),
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
  instance: once(async () =>
    createRouter((await import("#routes/instance.ts")).instanceRoutes),
  ),
  join: lazyExport(() => import("#routes/join.ts"), "routeJoin"),
  news: lazyExport(() => import("#routes/public/news.ts"), "routeNews"),
  order: lazyExport(() => import("#routes/public/order.ts"), "routeOrder"),
  orderJs: lazyExport(
    () => import("#routes/public/order-js.ts"),
    "handleOrderJs",
  ),
  payment: lazyExport(() => import("#routes/api/webhooks.ts"), "routePayment"),
  publicPages: once(() => import("#routes/public/pages.ts")),
  renewal: lazyRouter(
    () => import("#routes/public/renewal.ts"),
    ({ handleRenewalGet, handleRenewalPost }) =>
      defineRoutes({
        "GET /renew": handleRenewalGet,
        "POST /renew": handleRenewalPost,
      }),
  ),
  scheduled: once(async () =>
    createRouter((await import("#routes/scheduled.ts")).scheduledRoutes),
  ),
  setup: once(async () =>
    (await import("#routes/setup.ts")).createSetupRouter(
      settings.setup.isComplete,
    ),
  ),
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
  unsubscribe: lazyRouter(
    () => import("#routes/public/unsubscribe.ts"),
    ({ handleUnsubscribeGet, handleUnsubscribePost }) =>
      defineRoutes({
        "GET /unsubscribe": handleUnsubscribeGet,
        "POST /unsubscribe": handleUnsubscribePost,
      }),
  ),
  wallet: lazyExport(() => import("#routes/wallet/index.ts"), "routeWallet"),
  walletWebservice: lazyExport(
    () => import("#routes/wallet/webservice.ts"),
    "routeWalletWebservice",
  ),
};
