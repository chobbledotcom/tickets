/**
 * Entity loading patterns for admin route handlers
 */

import type { AuthSession } from "#routes/auth.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import type { EntityHandler } from "#routes/entity.ts";
import { withEntity } from "#routes/entity.ts";
import { notFoundResponse } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";

/**
 * Curried factory: creates a wrapper that takes load params, then a handler.
 * Eliminates the boilerplate of writing `(params, handler) => withEntity(handler)(() => loadFn(params))`.
 */
export const withEntityLoader =
  <T, P extends unknown[]>(load: (...args: P) => Promise<T | null>) =>
  (...args: P) =>
  (handler: EntityHandler<T>): Promise<Response> =>
    withEntity(handler)(() => load(...args));

type GetEntityHandler<T> = (
  request: Request,
  session: AuthSession,
  entity: T,
) => Response | Promise<Response>;

type PostEntityHandler<T> = (
  session: AuthSession,
  form: FormParams,
  entity: T,
) => Response | Promise<Response>;

type SessionHandler = (session: AuthSession) => Response | Promise<Response>;

/**
 * Generic factory: combine an auth wrapper with entity loading.
 * Eliminates duplication between withSessionAndEntity and withAuthAndEntity.
 */
const createEntityHandler =
  <T, H extends GetEntityHandler<T> | PostEntityHandler<T>>(
    authWrapper: (
      request: Request,
      cb: (
        session: AuthSession,
        ...rest: unknown[]
      ) => Response | Promise<Response>,
    ) => Promise<Response>,
    adaptHandler: (
      handler: H,
      request: Request,
      ...rest: unknown[]
    ) => (session: AuthSession, entity: T) => Response | Promise<Response>,
  ) =>
  (loader: (id: number) => Promise<T | null>) =>
  (request: Request, id: number) =>
  (handler: H): Promise<Response> =>
    authWrapper(request, (session, ...rest) =>
      withEntity((entity: T) =>
        adaptHandler(handler, request, ...rest)(session, entity),
      )(() => loader(id)),
    );

/* jscpd:ignore-start */
/**
 * Curried: require session, load entity with session-dependent loader, call handler.
 * Eliminates: `requireSessionOr(request, (session) => withLoader(session, id)(handler))`
 */
export const withSessionAndEntity = <T>(
  loader: (id: number) => Promise<T | null>,
) =>
  createEntityHandler<T, GetEntityHandler<T>>(
    (request, cb) => requireSessionOr(request, cb as SessionHandler),
    (handler, request) => (session, entity) =>
      handler(request, session, entity),
  )(loader);

/**
 * Curried: require auth + CSRF, load entity with session-dependent loader, call handler with form.
 * Eliminates: `withAuth(request, AUTH_FORM, (session, form) => withLoader(session, id)(handler))`
 */
export const withAuthAndEntity = <T>(
  loader: (id: number) => Promise<T | null>,
) =>
  createEntityHandler<T, PostEntityHandler<T>>(
    (request, cb) =>
      withAuth(
        request,
        AUTH_FORM,
        cb as (s: AuthSession, f: FormParams) => Response,
      ),
    (handler, _request, form) => (session, entity) =>
      handler(session, form as FormParams, entity),
  )(loader);

/**
 * Compose a session-dependent entity loader with auth guards.
 * Returns { get, post } handlers that handle auth + entity loading.
 */
export const withAuthEntityHandlers =
  <T>(loader: (id: number) => Promise<T | null>) =>
  (request: Request, id: number) => ({
    get: (
      handler: (
        request: Request,
        session: AuthSession,
        entity: T,
      ) => Response | Promise<Response>,
    ) => withSessionAndEntity(loader)(request, id)(handler),
    post: (
      handler: (
        session: AuthSession,
        form: FormParams,
        entity: T,
      ) => Response | Promise<Response>,
    ) => withAuthAndEntity(loader)(request, id)(handler),
  });

/**
 * Curried factory for GET/POST entity route handler pairs.
 * Eliminates boilerplate of calling withAuthEntityHandlers twice.
 *
 * Usage:
 *   const handlers = createEntityRouteHandlers(loader, p => p.attendeeId);
 *   export const get = handlers.get((request, session, entity) => ...);
 *   export const post = handlers.post((session, form, entity) => ...);
 */
export const createEntityRouteHandlers = <
  T,
  TParams extends Record<string, unknown>,
>(
  loader: (id: number) => Promise<T | null>,
  getId: (params: TParams) => number,
) => {
  const routeHandler =
    <H>(
      wrapper: (
        l: (i: number) => Promise<T | null>,
      ) => (r: Request, i: number) => (h: H) => Promise<Response>,
      handler: H,
    ): ((request: Request, params: TParams) => Promise<Response>) =>
    (request, params) =>
      wrapper(loader)(request, getId(params))(handler);

  return {
    get: (
      handler: (
        request: Request,
        session: AuthSession,
        entity: T,
      ) => Response | Promise<Response>,
    ) => routeHandler(withSessionAndEntity, handler),
    post: (
      handler: (
        session: AuthSession,
        form: FormParams,
        entity: T,
      ) => Response | Promise<Response>,
    ) => routeHandler(withAuthAndEntity, handler),
  };
};
/* jscpd:ignore-end */

/**
 * Generic wrapper for typed route params: parse param as number, load entity,
 * return 404 if missing, otherwise call handler.
 */
export const withEntityFromParam = <T>(
  paramValue: string | number | undefined,
  load: (id: number) => Promise<T | null>,
  handler: EntityHandler<T>,
): Promise<Response> => {
  const id =
    typeof paramValue === "string"
      ? Number.parseInt(paramValue, 10)
      : paramValue;
  if (id === undefined || Number.isNaN(id)) {
    return Promise.resolve(notFoundResponse());
  }
  return withEntity(handler)(() => load(id!));
};
