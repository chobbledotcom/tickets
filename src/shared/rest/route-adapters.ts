/** Turn a typed route handler into the promise-returning shape a record's
 *  page bundle expects. */

import type { IdRouteHandler } from "#routes/entity.ts";
import type { RequestRoute } from "#shared/response-steps.ts";

/** A handler that can answer synchronously, as a typed route handler can. */
type MaybeAsyncRoute = (
  request: Request,
  params: never,
) => Response | Promise<Response>;

type MaybeAsyncIdRoute = (
  request: Request,
  params: { id: number },
) => Response | Promise<Response>;

export const asRequestRoute =
  (handler: MaybeAsyncRoute): RequestRoute =>
  (request) =>
    Promise.resolve(handler(request, {} as never));

export const asIdRoute =
  (handler: MaybeAsyncIdRoute): IdRouteHandler =>
  (request, params) =>
    Promise.resolve(handler(request, params));
