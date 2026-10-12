import { isOneOf } from "#fp";
import { readOnlyGetRoutePatterns } from "#shared/admin-pages.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";

const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

/** The admin sign-in and sign-out. They are the only admin writes that stay
 * open while an update runs. */
const READ_ONLY_SIGN_IN_OUT_PATHS = ["/admin/login", "/admin/logout"];

const READ_ONLY_ADMIN_OPERATION_PATTERNS = [
  "/admin/attendees/:attendeeId/refresh-payment",
  "/admin/backup/create",
  "/admin/debug/sentry",
  "/admin/deliveries/mark",
  "/admin/listing/:id/scan",
  "/admin/listing/:listingId/attendee/:attendeeId/checkin",
  "/admin/groups/:id/scan",
  ...READ_ONLY_SIGN_IN_OUT_PATHS,
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

const isMutatingMethod = isOneOf(["DELETE", "PATCH", "POST", "PUT"]);

/** The webhook paths whose senders redeliver after any non-2xx answer
 * (payment providers, the SMS gateway). Update mode blocks them with the API
 * response, so a delivery that lands mid-update comes back after it. */
const RETRYING_WEBHOOK_PATHS = [/^\/payment\/webhook$/, /^\/sms\/webhook$/];

const isAdminMutation = (path: string, method: string): boolean =>
  isMutatingMethod(method) && path.startsWith("/admin/");

type ReadOnlyRequest = {
  method: string;
  mutating: boolean;
  path: string;
  updating: boolean;
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

const isSignInOrOut = sentTo(
  "POST",
  READ_ONLY_SIGN_IN_OUT_PATHS.map(routePathPatternToRegex),
);

const isSafePath = pathIn(READ_ONLY_SAFE_PATHS);

const isRetryingWebhook = pathIn(RETRYING_WEBHOOK_PATHS);

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
    // Ordinary read-only mode keeps every allowed admin operation. Update
    // mode refuses admin writes too, and keeps only the sign-in and
    // sign-out, because the migration must see a still database.
    decide: (request) => (isAllowedAdminOperation(request) ? null : "page"),
    matches: (request) =>
      isAdminMutation(request.path, request.method) &&
      (!request.updating || isSignInOrOut(request)),
  },
  {
    decide: fixedDecision(null),
    matches: ({ mutating }) => !mutating,
  },
  {
    // A webhook delivery that lands mid-update gets the API answer its
    // sender redelivers, not the human redirect.
    decide: fixedDecision("api"),
    matches: ({ path, updating }) => updating && isRetryingWebhook(path),
  },
  {
    // In update mode no public write stays safe: the migration must see a
    // still database.
    decide: ({ path, updating }) =>
      !updating && isSafePath(path) ? null : "page",
    matches: () => true,
  },
];

/**
 * Decide whether read-only mode blocks one request. `updating` is true while
 * UPDATE_IN_PROGRESS is set. The caller turns the decision into a response,
 * with the update message and status in the update case. Environment and
 * request-context reads stay out of this module.
 */
export const readOnlyBlock = (
  path: string,
  method: string,
  updating: boolean,
): ReadOnlyDecision => {
  const request = {
    method,
    mutating: isMutatingMethod(method),
    path,
    updating,
  };
  // The final rule always matches, so every request has a decision.
  const rule = READ_ONLY_RULES.find((candidate) => candidate.matches(request))!;
  return rule.decide(request);
};
