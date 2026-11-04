import { isOneOf } from "#fp";
import {
  readOnlyGetRoutePatterns,
  readOnlyWriteRoutePatterns,
} from "#shared/admin-pages.ts";
import { constant } from "#shared/fp-bind.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { READ_ONLY_SAFE_ROUTES } from "./read-only-safe-routes.ts";

/** The admin writes read-only mode keeps open, and the narrower set that also
 * stays open while an update runs. Both come from the route declarations. */
const READ_ONLY_WRITE_PATTERNS = readOnlyWriteRoutePatterns(false).map(
  routePathPatternToRegex,
);
const UPDATE_WRITE_PATTERNS = readOnlyWriteRoutePatterns(true).map(
  routePathPatternToRegex,
);

const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

const READ_ONLY_SAFE_PATTERNS = READ_ONLY_SAFE_ROUTES.map(({ pattern }) =>
  routePathPatternToRegex(pattern),
);

const isMutatingMethod = isOneOf(["DELETE", "PATCH", "POST", "PUT"]);

/** The webhook paths whose senders redeliver after any non-2xx answer
 * (payment providers, the SMS gateway). Update mode blocks them with the API
 * response, so a delivery that lands mid-update comes back after it. */
const RETRYING_WEBHOOK_PATHS = READ_ONLY_SAFE_ROUTES.filter(
  (route) => route.retryingWebhook === true,
).map(({ pattern }) => routePathPatternToRegex(pattern));

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

const isReadOnlyWrite = sentTo("POST", READ_ONLY_WRITE_PATTERNS);

const isUpdateWrite = sentTo("POST", UPDATE_WRITE_PATTERNS);

const isSafePath = pathIn(READ_ONLY_SAFE_PATTERNS);

const isRetryingWebhook = pathIn(RETRYING_WEBHOOK_PATHS);

/** Ordered from the most specific request to the default public-write rule. */
const READ_ONLY_RULES: readonly ReadOnlyRule[] = [
  {
    decide: constant("api"),
    matches: ({ mutating, path }) => mutating && path.startsWith("/api/"),
  },
  {
    decide: constant("page"),
    matches: sentTo("GET", READ_ONLY_GET_PATTERNS),
  },
  {
    // Read-only mode keeps the admin writes their routes declare. Update
    // mode keeps only the ones declared `"always"`, the sign-in and
    // sign-out, because the migration must see a still database.
    decide: (request) =>
      (request.updating ? isUpdateWrite : isReadOnlyWrite)(request)
        ? null
        : "page",
    matches: ({ path, method }) => isAdminMutation(path, method),
  },
  {
    decide: constant(null),
    matches: ({ mutating }) => !mutating,
  },
  {
    // A webhook delivery that lands mid-update gets the API answer its
    // sender redelivers, not the human redirect.
    decide: constant("api"),
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
