/**
 * The gates and policies that take their roles from a declared route pattern.
 * A route writes its pattern once, and the pattern names the roles (see
 * "Keep methods flat" in AGENTS.md). `admin-surface/areas.ts` stays the one
 * place a role is written down, and
 * `test/integration/admin-role-matrix.test.ts` proves each gate still agrees
 * with its declaration.
 */

import { adminDestinationAt } from "#shared/admin-surface.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  type AuthPolicy,
  type AuthSession,
  authPage,
  formGuard,
  formPolicyFor,
  type Guard,
  pageGuardFor,
  type SessionGuard,
} from "./auth.ts";

/** A GET page's gate at a declared route pattern. */
export const pageGuardAt = (pattern: string): SessionGuard<AuthSession> =>
  pageGuardFor(adminDestinationAt(pattern));

/** A form POST's policy at a declared route pattern. */
export const formPolicyAt = (pattern: string): AuthPolicy<"form"> =>
  formPolicyFor(adminDestinationAt(pattern));

/** A form POST's gate at a declared route pattern. */
export const formGuardAt = (
  pattern: string,
): Guard<[session: AuthSession, form: FormParams]> =>
  formGuard(formPolicyAt(pattern));

/** Run a session handler under a page's gate, the audience from the route's
 * declaration. */
export const pageGuardRun = (
  pattern: string,
  request: Request,
  run: (session: AuthSession) => Promise<Response>,
): Promise<Response> => pageGuardAt(pattern)(request, run);

/** A GET page at a declared route pattern, guarded by the roles that route
 * declares. */
export const authPageAt = (pattern: string) => authPage(pageGuardAt(pattern));
