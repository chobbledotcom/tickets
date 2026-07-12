/**
 * Entity loading patterns for route handlers
 */

import {
  type AuthSession,
  OWNER_FORM,
  requireSessionOr,
} from "#routes/auth.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";

/**
 * Resolve a nullable promise, calling handler if found or returning 404.
 * Use for any route that loads a model and should 404 when missing.
 */
export const orNotFound = async <T>(
  load: Promise<T | null>,
  handler: (data: T) => Response | Promise<Response>,
): Promise<Response> => {
  const data = await load;
  return data
    ? handler(data)
    : (await import("#routes/response.ts")).notFoundResponse();
};

/** Handler that receives a loaded entity */
export type EntityHandler<T> = (entity: T) => Response | Promise<Response>;

/** Handler for a POST that carries a record id, the session, and the form. */
export type IdFormHandler = (
  id: number,
  session: AuthSession,
  form: FormParams,
) => Response | Promise<Response>;

/**
 * Generic wrapper: load entity, return 404 if missing, otherwise call handler.
 * Curried so the handler is specified first, then the load function.
 */
export const withEntity =
  <T>(handler: EntityHandler<T>) =>
  (load: () => Promise<T | null>): Promise<Response> =>
    orNotFound(load(), handler);

/** The `{ id: number }` params a single-`:id` route receives. */
export type IdParam = { id: number };

/** Route handler that takes request + { id } params */
export type IdRouteHandler = (
  request: Request,
  params: IdParam,
) => Promise<Response>;

/** Route params for attendee-scoped routes */
export type AttendeeRouteParams = { attendeeId: number };

/** Route params for attendee + listing-scoped routes */
export type AttendeeListingRouteParams = {
  attendeeId: number;
  listingId: number;
};

/** An auth gate a `:id` route runs before touching its entity: it yields the
 * gate's context (a session, a parsed form, …) to the inner handler. */
type EntityGate<C> = (
  request: Request,
  handler: (ctx: C) => Response | Promise<Response>,
) => Promise<Response>;

/**
 * Gated `:id` route factory — the one shape behind every "auth, load the
 * entity, 404 when missing, then handle it" route. The gate decides who may
 * pass and what context the handler sees.
 */
export const gatedEntityRoute =
  <C>(gate: EntityGate<C>) =>
  <T>(
    load: (id: number) => Promise<T | null>,
    use: (entity: T, ctx: C) => Response | Promise<Response>,
  ): IdRouteHandler =>
  (request, params) => {
    const loadEntity = () => load(params.id);
    return gate(request, (ctx) =>
      withEntity<T>((entity) => use(entity, ctx))(loadEntity),
    );
  };

/**
 * Owner GET-by-ID route handler factory.
 * Loads entity by ID, returns 404 if missing, renders with session context,
 * and requires the owner role.
 */
export const ownerGetById = <T>(
  load: (id: number) => Promise<T | null>,
  render: (entity: T, session: AuthSession) => Response | Promise<Response>,
): IdRouteHandler =>
  gatedEntityRoute<AuthSession>((request, handler) =>
    requireSessionOr(request, handler, "owner"),
  )(load, render);

/** Owner POST-by-ID + CSRF */
export const ownerFormById = (handler: IdFormHandler): IdRouteHandler =>
  createAuthedHandler<{ id: number }>({
    auth: OWNER_FORM,
    handle: ({ form, params, session }) => handler(params.id, session, form),
  });
