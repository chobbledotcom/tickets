/**
 * Entity loading patterns for route handlers
 */

/* jscpd:ignore-start */
import {
  type AuthSession,
  type Guard,
  OWNER_FORM,
  requireOwnerOr,
} from "#routes/auth.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
/* jscpd:ignore-end */

/**
 * Resolve a nullable promise, calling handler if found or returning 404.
 * Use for any route that loads a model and should 404 when missing.
 */
export const orNotFound = async <T>(
  load: Promise<T | null>,
  handler: ResponseHandler<[data: T]>,
): Promise<Response> => {
  const data = await load;
  return data
    ? handler(data)
    : (await import("#routes/response.ts")).notFoundResponse();
};

/** Loads a record by its id, or null when there is none. The one loader shape
 *  every gated `:id` route (and the Site-tab editors) is built on. */
export type EntityLoader<T> = (id: number) => Promise<T | null>;

/** Load through a parent, returning null before the child lookup when missing. */
export const throughParent = async <Parent, Context>(
  load: Promise<Parent | null>,
  child: (parent: Parent) => Context | null | Promise<Context | null>,
): Promise<Context | null> => {
  const parent = await load;
  return parent ? child(parent) : null;
};

/** Handler for a POST that carries a record id, the session, and the form. */
export type IdFormHandler = ResponseHandler<
  [id: number, session: AuthSession, form: FormParams]
>;

/**
 * Generic wrapper: load entity, return 404 if missing, otherwise call handler.
 * Curried so the handler is specified first, then the load function.
 */
export const withEntity =
  <T>(handler: ResponseHandler<[entity: T]>) =>
  (load: () => Promise<T | null>): Promise<Response> =>
    orNotFound(load(), handler);

/** The `{ id: number }` params a single-`:id` route receives. */
export type IdParam = { id: number };

/** Route handler that takes request + { id } params */
export type IdRouteHandler = ParamsRoute<IdParam>;

/** Wrap a plain `(request, id)` action as an `:id` route handler — unpacking
 * the id from the route params so the action never sees the params shape. */
export const idRouteFor =
  (run: (request: Request, id: number) => Promise<Response>): IdRouteHandler =>
  (request, params) =>
    run(request, params.id);

/** Route params for attendee-scoped routes */
export type AttendeeRouteParams = { attendeeId: number };

/** Route params for attendee + listing-scoped routes */
export type AttendeeListingRouteParams = {
  attendeeId: number;
  listingId: number;
};

/**
 * Gated entity route factory: authenticate first, load from the typed route
 * params, return 404 when missing, then run the action. The action also receives
 * the request and params for routes that need more than the loaded entity.
 */
export type EntityHandler<TParams, T> = <TContext extends unknown[]>(
  auth: Guard<TContext>,
) => (
  action: ResponseHandler<
    [entity: T, ...context: TContext, request: Request, params: TParams]
  >,
) => ParamsRoute<TParams>;

export const createEntityHandler =
  <TParams, T>(
    load: (params: TParams) => Promise<T | null>,
  ): EntityHandler<TParams, T> =>
  (auth) =>
  (action) =>
  (request, params) =>
    auth(request, (...context) =>
      withEntity<T>((entity) => action(entity, ...context, request, params))(
        () => load(params),
      ),
    );

/** The common `:id` form of {@link createEntityHandler}. */
export const createIdEntityHandler = <T>(
  load: EntityLoader<T>,
): EntityHandler<IdParam, T> =>
  createEntityHandler(({ id }: IdParam) => load(id));

/**
 * Owner GET-by-ID route handler factory.
 * Loads entity by ID, returns 404 if missing, renders with session context,
 * and requires the owner role.
 */
export const ownerGetById = <T>(
  load: EntityLoader<T>,
  render: ResponseHandler<[entity: T, session: AuthSession]>,
): IdRouteHandler => createIdEntityHandler(load)(requireOwnerOr)(render);

/** Owner POST-by-ID + CSRF */
export const ownerFormById = (handler: IdFormHandler): IdRouteHandler =>
  createAuthedHandler<{ id: number }>({
    auth: OWNER_FORM,
    handle: ({ form, params, session }) => handler(params.id, session, form),
  });
