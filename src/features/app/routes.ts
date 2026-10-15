/* jscpd:ignore-start -- imports */
import { t, withMessageGroups } from "#i18n";
import type { MessageGroup } from "#locales/manifest.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { notFoundResponse, redirectResponse } from "#routes/response.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import { isReadOnly, isUpdateInProgress } from "#shared/env.ts";
import type { PrefixLoaderThunk } from "./prefix-loaders.ts";
import { getPrefix, PREFIX_ROUTES, type PrefixSpec } from "./prefixes.ts";
import { readOnlyBlock } from "./read-only.ts";
import { isSetupPath } from "./rules.ts";

/* jscpd:ignore-end */

type PrefixRoute = {
  beforeMessages: (path: string, method: string) => Response | null;
  handler: PathMethodRoute;
  messageGroups: readonly MessageGroup[];
};

const continueRoute = (_path: string, _method: string): null => null;

const prefixRoute = (
  messageGroups: readonly MessageGroup[] = [],
  handler: PathMethodRoute,
  beforeMessages: PrefixRoute["beforeMessages"] = continueRoute,
): PrefixRoute => ({ beforeMessages, handler, messageGroups });

const lazyRoute =
  (load: () => Promise<PathMethodRoute>): PathMethodRoute =>
  async (request, path, method) =>
    (await load())(request, path, method);

const isServedEntry = (
  entry: [string, PrefixSpec],
): entry is [string, PrefixSpec & { loader: PrefixLoaderThunk }] =>
  entry[1].loader !== undefined;

/** The declaration as the fold reads it: every prefix as its spec. */
const declaredPrefixes: Record<string, PrefixSpec> = PREFIX_ROUTES;

/** Build each served prefix's dispatchable route from its declaration. */
export const prefixHandlers: Record<string, PrefixRoute> = Object.fromEntries(
  Object.entries(declaredPrefixes)
    .filter(isServedEntry)
    .map(([prefix, spec]) => [
      prefix,
      prefixRoute(spec.groups, lazyRoute(spec.loader.run), spec.gate),
    ]),
);

type AppRouteRequest = {
  method: string;
  path: string;
  request: Request;
};

type CompletePathMethodRoute = (
  ...args: Parameters<PathMethodRoute>
) => Promise<Response>;

/** Give complete app routes one named request value instead of four arguments. */
export const defineAppRoute =
  (
    handle: (route: AppRouteRequest) => Promise<Response>,
  ): CompletePathMethodRoute =>
  (request, path, method) =>
    handle({ method, path, request });

/** Read-only mode message. */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

const readOnlyResponses = {
  // Update mode answers 503: payment providers and the SMS gateway redeliver
  // a webhook that gets a non-2xx answer.
  api: (updating: boolean): Response =>
    updating
      ? apiErrorResponse(t("public.update_in_progress.message"), 503)
      : apiErrorResponse(READ_ONLY_MESSAGE, 403),
  page: (): Response => redirectResponse("/read-only"),
} as const;

/** Prefixes whose routes are all GET, each proven by that prefix's own
 * route table. The three public page prefixes lead the list. Name a prefix
 * here only from that proof. A false entry answers real requests with a
 * 404. Leave a prefix out when unsure. A missing entry only loses the fast
 * 404. */
const GET_ONLY_PREFIXES: readonly string[] = [
  "",
  "listings",
  "terms",
  "address-lookup",
  "attachment",
  "caldav",
  "custom.css",
  "events",
  "feeds",
  "gwallet",
  "image",
  "news",
  "order",
  "order.js",
  "page",
  "read-only",
  "t",
  "wallet",
];

/** Whether a body-bearing request can route here: the setup
 * router, or a prefix route that serves a body-bearing method. Coarse by
 * design — deeper 404s (missing slugs, unknown admin tabs) still need the
 * database. */
export const servesBodyRequests = (path: string): boolean => {
  if (isSetupPath(path)) return true;
  const prefix = getPrefix(path);
  return (
    Object.hasOwn(prefixHandlers, prefix) && !GET_ONLY_PREFIXES.includes(prefix)
  );
};

/** Route main application requests after setup is complete. */
export const routeMainApp = async ({
  request,
  path,
  method,
}: AppRouteRequest): Promise<Response> => {
  if (isReadOnly()) {
    const updating = isUpdateInProgress();
    const blocked = readOnlyBlock(path, method, updating);
    if (blocked === "api") return readOnlyResponses.api(updating);
    if (blocked === "page") return readOnlyResponses.page();
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
      (await route.handler(request, path, method)) ?? notFoundResponse(),
  );
};
