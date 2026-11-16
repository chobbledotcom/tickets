/** Turn a typed route handler into the promise-returning shape a record's
 *  page bundle expects. */

import type { RequestRoute } from "#shared/response-steps.ts";

/** A handler that can answer synchronously, as a typed route handler can. */
type MaybeAsyncRoute = (
  request: Request,
  params: never,
) => Response | Promise<Response>;

export const asRequestRoute =
  (handler: MaybeAsyncRoute): RequestRoute =>
  (request) =>
    Promise.resolve(handler(request, {} as never));
