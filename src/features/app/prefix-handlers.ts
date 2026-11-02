/**
 * How an app prefix is served: the lazy module loaders, the public-page
 * handler, and the handlers that are not a lazy router. The declaration
 * that names a handler for each prefix is `prefixes.ts`.
 */

/* jscpd:ignore-start -- imports */

import { settings } from "#db/settings.ts";
import { once } from "#fp";
import { withMessageGroups } from "#i18n";
import {
  ADMIN_API_MESSAGE_GROUPS,
  PUBLIC_API_MESSAGE_GROUPS,
} from "#locales/groups.ts";
import { publicPageResponse, redirectResponse } from "#routes/response.ts";
import {
  createRouter,
  defineRoutes,
  type RouteHandlerFn,
} from "#routes/router.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { readOnlyPage } from "#templates/public/errors.tsx";
import type { PrefixGate } from "./prefix-fold.ts";

/* jscpd:ignore-end */

/** Create a lazy-loaded route handler (prefix already matched by dispatch map). */
const lazyRoute =
  (load: () => Promise<PathMethodRoute>): PathMethodRoute =>
  async (request, path, method) =>
    (await load())(request, path, method);

/** Load one module on first match and answer with the route it names. */
export const routeFromModule = <
  M extends Record<K, PathMethodRoute>,
  K extends keyof M & string,
>(
  load: () => Promise<M>,
  key: K,
): PathMethodRoute => lazyRoute(once(async () => (await load())[key]));

/** Load one module on first match and answer with a router over the route
 * table the picker names. */
export const routerFromModule = <M>(
  load: () => Promise<M>,
  routes: (module: M) => Record<string, RouteHandlerFn>,
): PathMethodRoute =>
  lazyRoute(once(async () => createRouter(routes(await load()))));

/** Load a module that names one GET and one POST handler for a public page,
 * and serve them at the given path. */
export const getPostRoute = <Module extends Record<string, RouteHandlerFn>>(
  load: () => Promise<Module>,
  getKey: keyof Module & string,
  postKey: keyof Module & string,
  path: string,
): PathMethodRoute =>
  routerFromModule(load, (module) =>
    defineRoutes({
      [`GET /${path}`]: module[getKey]!,
      [`POST /${path}`]: module[postKey]!,
    }),
  );

// The public page handlers load on first match. The custom prefix handlers
// below call them directly.
const loadPublicPages = once(() => import("#routes/public/pages.ts"));

type PublicPagesModule = Awaited<ReturnType<typeof loadPublicPages>>;

const loadAdminApiRoutes = routerFromModule(
  () => import("#routes/admin/api.ts"),
  ({ adminApiRoutes }) => adminApiRoutes,
);

const handlerLoaders = {
  customCss: once(
    async () => (await import("#routes/public/custom-css.ts")).handleCustomCss,
  ),
  orderJs: once(
    async () => (await import("#routes/public/order-js.ts")).handleOrderJs,
  ),
};

// Loaders shared by more than one prefix. Each prefix that serves one names
// it in the declaration.
export const feedRoutes = routeFromModule(
  () => import("#routes/feeds.ts"),
  "routeFeed",
);

export const ticketRoutes = routeFromModule(
  () => import("#routes/public/ticket-routes.ts"),
  "routeTicket",
);

/** A gate that redirects a GET to login while the public site is off. */
const disabledPublicSiteGet: PrefixGate = (_path, method) =>
  method === "GET" && !settings.features.site
    ? redirectResponse("/admin/login")
    : null;

export const requirePublicSiteGet =
  (expectedPath: string): PrefixGate =>
  (path, method) =>
    path === expectedPath ? disabledPublicSiteGet(path, method) : null;

const publicPagePath = (prefix: string): string =>
  prefix === "" ? "/" : `/${prefix}`;

/** One public page's handler, picked from the loaded page module. */
type PublicPagePick = (
  pages: PublicPagesModule,
) => ResponseHandler<[request: Request]>;

/** Serve one handler at its exact path, on GET only. A null answer falls
 * through to the next route. */
const exactPathGet =
  (
    expectedPath: string,
    handle: (request: Request) => Response | null | Promise<Response | null>,
  ): PathMethodRoute =>
  async (request, path, method) =>
    path === expectedPath && method === "GET" ? handle(request) : null;

/** The route facts a GET-only prefix behind the public site switch declares. */
type PublicSiteGetRoute = {
  gate: PrefixGate;
  getOnly: true;
  handler: PathMethodRoute;
};

/** The route facts every public page shares: its exact-path gate, its GET-only
 * proof, and its handler. */
export const publicPageRoute = (
  prefix: string,
  pick: PublicPagePick,
): PublicSiteGetRoute => {
  const path = publicPagePath(prefix);
  return {
    gate: requirePublicSiteGet(path),
    getOnly: true,
    handler: exactPathGet(path, async (request) =>
      pick(await loadPublicPages())(request),
    ),
  };
};

/** The route facts a public page behind the site switch shares, such as the
 * news list: a GET answers the page, or the login redirect. */
export const publicSiteGetRoute = (
  handler: PathMethodRoute,
): PublicSiteGetRoute => ({
  gate: disabledPublicSiteGet,
  getOnly: true,
  handler,
});

export const contactPrefixHandler: PathMethodRoute = async (
  request,
  path,
  method,
) => {
  if (path !== "/contact") return null;
  const pages = await loadPublicPages();
  if (method === "GET") return pages.handlePublicContact(request);
  if (method === "POST") return pages.handlePublicContactSubmit(request);
  return null;
};

export const legacyEventsRedirectHandler = exactPathGet("/events", () =>
  settings.features.site ? redirectResponse("/listings") : null,
);

export const orderJsPrefixHandler = exactPathGet("/order.js", async (request) =>
  (await handlerLoaders.orderJs())(request),
);

export const customCssPrefixHandler = exactPathGet("/custom.css", async () =>
  (await handlerLoaders.customCss())(),
);

export const apiPrefixHandler: PathMethodRoute = async (
  request,
  path,
  method,
) => {
  if (path.startsWith("/api/admin/")) {
    // Dynamic import: the gate module stays free of resource imports, so an
    // unauthenticated request is refused before any resource copy loads. The
    // resource modules translate form schemas while they evaluate, so they
    // load inside the API's message groups, after the gate passes.
    const { requireAdminApiOr } = await import("#routes/admin/api-mount.ts");
    return await requireAdminApiOr(request, () =>
      withMessageGroups(ADMIN_API_MESSAGE_GROUPS, () =>
        loadAdminApiRoutes(request, path, method),
      ),
    );
  }
  return settings.showPublicApi
    ? withMessageGroups(PUBLIC_API_MESSAGE_GROUPS, async () =>
        (await import("#routes/api/index.ts")).routeApi(request, path, method),
      )
    : null;
};

export const readOnlyInfoHandler = exactPathGet("/read-only", () =>
  publicPageResponse(readOnlyPage),
);
