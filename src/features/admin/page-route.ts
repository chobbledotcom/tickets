import { type AuthSession, pageGuardRun } from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

/** Gate a request by its route's declaration and load the data its handler
 * needs. The audience is written once, in the admin surface. */
export const withPageData =
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
 * Gate a request by its route's declaration, look a value up, and 404 when it
 * is absent. Otherwise hand the found value (and the session) to `whenFound`.
 * Both the built-sites (`:id` → site) and ledger (session → HTML) routes share
 * this "authenticate → look up or 404 → respond" shape.
 */
export const pageFoundOr404 = <T>(
  pattern: string,
  request: Request,
  find: (session: AuthSession) => Promise<T | null>,
  whenFound: ResponseHandler<[found: T, session: AuthSession]>,
): Promise<Response> =>
  withPageData(pattern, find)(request, (session, found) =>
    found === null ? notFoundResponse() : whenFound(found, session),
  );
