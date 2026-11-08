/**
 * The gates and policies that take their roles from a declared route. A gate
 * names its route by the declaration's id, or by the path its route table key
 * uses (see "Keep methods flat" in AGENTS.md). `admin-surface/areas.ts` stays
 * the one place a role is written down, and
 * `test/integration/admin-role-matrix.test.ts` proves each gate still agrees
 * with its declaration.
 */

import { adminDestinationAt } from "#shared/admin-surface.ts";
import type { Flash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { RequestRoute, ResponseHandler } from "#shared/response-steps.ts";
import {
  type AuthPolicy,
  type AuthSession,
  authPage,
  authResponsePage,
  formGuard,
  formPolicyFor,
  type Guard,
  gatedPost,
  pageGuardFor,
  type SessionGuard,
} from "./auth.ts";

/** A GET page's gate at a declared route. */
export const pageGuardAt = (route: string): SessionGuard<AuthSession> =>
  pageGuardFor(adminDestinationAt(route));

/** A form POST's policy at a declared route. */
export const formPolicyAt = (route: string): AuthPolicy<"form"> =>
  formPolicyFor(adminDestinationAt(route));

/** A form POST's gate at a declared route. */
export const formGuardAt = (
  route: string,
): Guard<[session: AuthSession, form: FormParams]> =>
  formGuard(formPolicyAt(route));

/** A POST route at a declared route whose handler returns the full Response.
 * The roles come from the route's declaration. */
export const gatedPostAt = (route: string) => gatedPost(formPolicyAt(route));

/** Run a session handler under a page's gate, the audience from the route's
 * declaration. */
export const pageGuardRun = (
  route: string,
  request: Request,
  run: (session: AuthSession) => Promise<Response>,
): Promise<Response> => pageGuardAt(route)(request, run);

/** A GET page at a declared route, guarded by the roles that route
 * declares. */
export const authPageAt = (route: string) => authPage(pageGuardAt(route));

/** What a response page's builder returns from: the session, the request, and
 * the flashed message values. */
type ResponsePageBuilder = ResponseHandler<
  [session: AuthSession, request: Request, flash: Flash]
>;

/** One guarded GET route, keyed by the pattern it serves, ready to spread into
 * a route table. */
type AuthResponsePageRoutes<Pattern extends string> = {
  [K in `GET ${Pattern}`]: RequestRoute;
};

/** A GET page whose builder returns the full Response. The page can then 404
 * or redirect instead of rendering one. The route key comes from the pattern,
 * so a page is always bound where its gate read the roles. */
export const authResponsePageRoute =
  <Pattern extends string>(pattern: Pattern) =>
  (build: ResponsePageBuilder): AuthResponsePageRoutes<Pattern> =>
    ({
      [`GET ${pattern}`]: authResponsePage(pageGuardAt(pattern))(build),
    }) as AuthResponsePageRoutes<Pattern>;
