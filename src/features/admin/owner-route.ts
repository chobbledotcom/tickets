import { type AuthSession, pageGuardRun } from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

/** Owner-gate a request and load the data its handler needs. The gate comes
 * from the route the handler serves, so the owner audience is written once,
 * in the admin surface. */
export const withOwnerData =
  <T>(
    pattern: string,
    load: (session: AuthSession, request: Request) => Promise<T>,
  ) =>
  (
    request: Request,
    handle: ResponseHandler<[session: AuthSession, data: T]>,
  ): Promise<Response> =>
    pageGuardRun(pattern, request, async (session) =>
      handle(session, await load(session, request)),
    );

/**
 * Owner-gate a request, look a value up, and 404 when it is absent — otherwise
 * hand the found value (and the session) to `whenFound`. Both the built-sites
 * (`:id` → site) and ledger (session → HTML) owner routes share this
 * "authenticate → look up or 404 → respond" shape.
 */
export const ownerFoundOr404 = <T>(
  pattern: string,
  request: Request,
  find: (session: AuthSession) => Promise<T | null>,
  whenFound: ResponseHandler<[found: T, session: AuthSession]>,
): Promise<Response> =>
  withOwnerData(pattern, find)(request, (session, found) =>
    found === null ? notFoundResponse() : whenFound(found, session),
  );
