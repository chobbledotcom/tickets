/**
 * Loader and gate implementations behind the prefix declaration in
 * `prefixes.ts`. A loader defers its module behind a literal dynamic import.
 * No route handler module is statically imported here. The pre-routing
 * settings pipeline can therefore read the declaration without loading the
 * app (see test/scripts/cold-start-imports.test.ts).
 */

/* jscpd:ignore-start -- imports */
import { settings } from "#db/settings.ts";
import { once } from "#fp";
import { withMessageGroups } from "#i18n";
import {
  ADMIN_API_MESSAGE_GROUPS,
  PUBLIC_API_MESSAGE_GROUPS,
} from "#locales/groups.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
import { createRouter, type RouteHandlerFn } from "#routes/router.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import { readOnlyPage } from "#templates/public/errors.tsx";
/* jscpd:ignore-end */

/**
 * How one prefix's dispatch is built: the lazy module load plus the export
 * it names, or an inline handler this module owns. The dispatch fold reads
 * every field. The paired fold test freezes the name fields from the
 * pre-fold tables and checks every entry against them.
 */
export type PrefixLoader =
  | { handler: PathMethodRoute; kind: "inline" }
  | { kind: "handler"; load: () => Promise<unknown>; pick: string }
  | {
      kind: "route-table";
      load: () => Promise<unknown>;
      routes: Readonly<Record<string, string>>;
    }
  | { kind: "routes-object"; load: () => Promise<unknown>; pick: string };

/** A gate that answers before message groups load. */
export type PrefixGate = (path: string, method: string) => Response | null;

/** Redirect a GET to the admin login when the public site is off. */
export const disabledPublicSiteGet = (
  _path: string,
  method: string,
): Response | null =>
  method === "GET" && !settings.features.site
    ? redirectResponse("/admin/login")
    : null;

/** Gate one exact GET path with the public-site check. */
export const requirePublicSiteGet =
  (expectedPath: string) =>
  (path: string, method: string): Response | null =>
    path === expectedPath ? disabledPublicSiteGet(path, method) : null;

/*
 * Loader builders. Each returns the declaration's loader data, which the
 * dispatch fold interprets. Import specifiers stay literal. esbuild bundles every
 * lazy target into the single edge file and still defers its evaluation
 * until first matched. Loaders shared by more than one prefix are named so
 * both prefixes reuse the same once-cached import.
 *
 * Each builder filters the module's keys by what the loader needs, so a
 * declaration entry that names a missing or wrong-shaped export fails to
 * compile.
 */

/** Lazily import a module once and pick one export from it. */
const lazyExport = <M, K extends keyof M>(
  load: () => Promise<M>,
  key: K,
): (() => Promise<M[K]>) => once(async () => (await load())[key]);

/** The module keys whose value extends the given shape. */
type KeysExtending<M, Shape> = {
  [K in keyof M & string]: M[K] extends Shape ? K : never;
}[keyof M & string];

/** The module keys whose value is a dispatchable route handler. */
type HandlerKey<M> = KeysExtending<M, PathMethodRoute>;

/** The module keys whose value is a route table the router accepts. */
type RoutesObjectKey<M> = KeysExtending<M, Record<string, RouteHandlerFn>>;

/** The module keys whose value is a handler a route pattern can bind. */
type TableHandlerKey<M> = KeysExtending<M, RouteHandlerFn>;

/**
 * Load one named export from the module. A handler dispatches directly. A
 * routes object goes through the router. The pick is compile-checked to
 * exist on the module with the kind's shape. The paired fold test freezes
 * every pick, and a wrong shape fails loudly on the first dispatch.
 */
export const exportLoader = <M>(
  kind: "handler" | "routes-object",
  load: () => Promise<M>,
  pick: HandlerKey<M> | RoutesObjectKey<M>,
): Extract<PrefixLoader, { kind: typeof kind }> =>
  ({ kind, load, pick }) as Extract<PrefixLoader, { kind: typeof kind }>;

/** Bind named handler exports from the module to method-path patterns. */
export const routeTableLoader = <M>(
  load: () => Promise<M>,
  routes: Readonly<Record<string, TableHandlerKey<M>>>,
): Extract<PrefixLoader, { kind: "route-table" }> => ({
  kind: "route-table",
  load,
  routes,
});

/** Serve a handler that this module defines instead of importing. */
export const inlineLoader = (
  handler: PathMethodRoute,
): Extract<PrefixLoader, { kind: "inline" }> => ({
  handler,
  kind: "inline",
});

/*
 * Loaders the declaration references by name. A loader shared by more than
 * one prefix reuses one once-cached import.
 */

export const feedLoader = exportLoader(
  "handler",
  () => import("#routes/feeds.ts"),
  "routeFeed",
);

export const ticketLoader = exportLoader(
  "handler",
  () => import("#routes/public/ticket-routes.ts"),
  "routeTicket",
);

export const googleWalletLoader = exportLoader(
  "handler",
  () => import("#routes/wallet/google.ts"),
  "routeGoogleWallet",
);

export const walletLoader = exportLoader(
  "handler",
  () => import("#routes/wallet/index.ts"),
  "routeWallet",
);

/** The public pages module, shared by the page prefixes and contact. */
export const loadPublicPages = once(() => import("#routes/public/pages.ts"));

const loadAdminApiRoutes = once(async () =>
  createRouter((await import("#routes/admin/api.ts")).adminApiRoutes),
);

const loadCustomCss = lazyExport(
  () => import("#routes/public/custom-css.ts"),
  "handleCustomCss",
);

const loadOrderJs = lazyExport(
  () => import("#routes/public/order-js.ts"),
  "handleOrderJs",
);

/*
 * Handlers for prefixes without a lazy router. Each checks its exact path
 * before it loads anything, so a probe on another path stays cheap.
 */

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

export const legacyEventsRedirectHandler: PathMethodRoute = async (
  _request,
  path,
  method,
) => {
  if (path !== "/events" || method !== "GET" || !settings.features.site) {
    return null;
  }
  return redirectResponse("/listings");
};

export const orderJsPrefixHandler: PathMethodRoute = async (
  request,
  path,
  method,
) => {
  if (path !== "/order.js" || method !== "GET") return null;
  return (await loadOrderJs())(request);
};

export const customCssPrefixHandler: PathMethodRoute = async (
  _request,
  path,
  method,
) => {
  if (path !== "/custom.css" || method !== "GET") return null;
  return (await loadCustomCss())();
};

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
      withMessageGroups(ADMIN_API_MESSAGE_GROUPS, async () =>
        (await loadAdminApiRoutes())(request, path, method),
      ),
    );
  }
  return settings.showPublicApi
    ? withMessageGroups(PUBLIC_API_MESSAGE_GROUPS, async () =>
        (await import("#routes/api/index.ts")).routeApi(request, path, method),
      )
    : null;
};

export const readOnlyInfoHandler: PathMethodRoute = (_request, path, method) =>
  path === "/read-only" && method === "GET"
    ? Promise.resolve(htmlResponse(readOnlyPage()))
    : Promise.resolve(null);
