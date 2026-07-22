import { readOnlyGetRoutePatterns } from "#shared/admin-pages.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";

const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

const READ_ONLY_ADMIN_OPERATION_PATTERNS = [
  "/admin/attendees/:attendeeId/refresh-payment",
  "/admin/backup/create",
  "/admin/debug/sentry",
  "/admin/deliveries/mark",
  "/admin/listing/:id/scan",
  "/admin/listing/:listingId/attendee/:attendeeId/checkin",
  "/admin/login",
  "/admin/logout",
  "/admin/support",
].map(routePathPatternToRegex);

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
  /^\/checkin\/[^/]+$/,
];

const isMutatingMethod = (method: string): boolean =>
  method === "DELETE" ||
  method === "PATCH" ||
  method === "POST" ||
  method === "PUT";

const isAdminMutation = (path: string, method: string): boolean =>
  isMutatingMethod(method) && path.startsWith("/admin/");

const isAllowedAdminOperation = (path: string, method: string): boolean =>
  method === "POST" &&
  READ_ONLY_ADMIN_OPERATION_PATTERNS.some((pattern) => pattern.test(path));

type ReadOnlyRequest = {
  method: string;
  mutating: boolean;
  path: string;
};

type ReadOnlyDecision = "api" | "page" | null;

type ReadOnlyRule = {
  decide: (request: ReadOnlyRequest) => ReadOnlyDecision;
  matches: (request: ReadOnlyRequest) => boolean;
};

const fixedDecision =
  (decision: ReadOnlyDecision) =>
  (_request: ReadOnlyRequest): ReadOnlyDecision =>
    decision;

/** Ordered from the most specific request to the default public-write rule. */
const READ_ONLY_RULES: readonly ReadOnlyRule[] = [
  {
    decide: fixedDecision("api"),
    matches: ({ mutating, path }) => mutating && path.startsWith("/api/"),
  },
  {
    decide: fixedDecision("page"),
    matches: ({ method, path }) =>
      method === "GET" &&
      READ_ONLY_GET_PATTERNS.some((pattern) => pattern.test(path)),
  },
  {
    decide: ({ method, path }) =>
      isAllowedAdminOperation(path, method) ? null : "page",
    matches: ({ method, path }) => isAdminMutation(path, method),
  },
  {
    decide: fixedDecision(null),
    matches: ({ mutating }) => !mutating,
  },
  {
    decide: ({ path }) =>
      READ_ONLY_SAFE_PATHS.some((pattern) => pattern.test(path))
        ? null
        : "page",
    matches: () => true,
  },
];

/**
 * Decide whether read-only mode blocks one request. The caller handles the
 * response, keeping environment and request-context reads out of this module.
 */
export const readOnlyBlock = (
  path: string,
  method: string,
): ReadOnlyDecision => {
  const request = { method, mutating: isMutatingMethod(method), path };
  // The final rule always matches, so every request has a decision.
  const rule = READ_ONLY_RULES.find((candidate) => candidate.matches(request))!;
  return rule.decide(request);
};
