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
import type { AdminLevel } from "#shared/types.ts";

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

/**
 * Generic wrapper: load entity, return 404 if missing, otherwise call handler.
 * Curried so the handler is specified first, then the load function.
 */
export const withEntity =
  <T>(handler: EntityHandler<T>) =>
  (load: () => Promise<T | null>): Promise<Response> =>
    orNotFound(load(), handler);

/** Route handler that takes request + { id } params */
export type IdRouteHandler = (
  request: Request,
  params: { id: number },
) => Promise<Response>;

/** Route params for attendee-scoped routes */
export type AttendeeRouteParams = { attendeeId: number };

/** Route params for attendee + event-scoped routes */
export type AttendeeEventRouteParams = {
  attendeeId: number;
  eventId: number;
};

/**
 * Authenticated GET-by-ID route handler factory.
 * Loads entity by ID, returns 404 if missing, renders with session context.
 * @param role - "owner" requires owner role, null allows any authenticated user
 */
export const authenticatedGetById =
  (role: AdminLevel | null) =>
  <T>(
    load: (id: number) => Promise<T | null>,
    render: (entity: T, session: AuthSession) => Response | Promise<Response>,
  ): IdRouteHandler =>
  (request, { id }) =>
    requireSessionOr(
      request,
      (session) =>
        withEntity<T>((entity) => render(entity, session))(() => load(id)),
      role ?? undefined,
    );

/** Shorthand: owner GET-by-ID */
export const ownerGetById = authenticatedGetById("owner");

/** Owner POST-by-ID + CSRF */
export const ownerFormById = (
  handler: (
    id: number,
    session: AuthSession,
    form: FormParams,
  ) => Response | Promise<Response>,
): IdRouteHandler =>
  createAuthedHandler<{ id: number }>({
    auth: OWNER_FORM,
    handle: ({ form, params, session }) => handler(params.id, session, form),
  });
