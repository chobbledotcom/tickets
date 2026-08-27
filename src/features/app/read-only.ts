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

/** Whether a path is one of a list. */
const pathIn =
  (patterns: readonly RegExp[]): ((path: string) => boolean) =>
  (path) =>
    patterns.some((pattern) => pattern.test(path));

/** Whether a request asks for one of a list of paths, by one method. */
const sentTo = (
  method: string,
  patterns: readonly RegExp[],
): ((request: ReadOnlyRequest) => boolean) => {
  const listed = pathIn(patterns);
  return (request) => request.method === method && listed(request.path);
};

const isAllowedAdminOperation = sentTo(
  "POST",
  READ_ONLY_ADMIN_OPERATION_PATTERNS,
);

const isSafePath = pathIn(READ_ONLY_SAFE_PATHS);

/** Ordered from the most specific request to the default public-write rule. */
const READ_ONLY_RULES: readonly ReadOnlyRule[] = [
  {
    decide: fixedDecision("api"),
    matches: ({ mutating, path }) => mutating && path.startsWith("/api/"),
  },
  {
    decide: fixedDecision("page"),
    matches: sentTo("GET", READ_ONLY_GET_PATTERNS),
  },
  {
    decide: (request) => (isAllowedAdminOperation(request) ? null : "page"),
    matches: ({ method, path }) => isAdminMutation(path, method),
  },
  {
    decide: fixedDecision(null),
    matches: ({ mutating }) => !mutating,
  },
  {
    decide: ({ path }) => (isSafePath(path) ? null : "page"),
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
