/**
 * REST route handler factories - integrates auth/CSRF with resource operations.
 *
 * Usage:
 *   const eventsResource = defineResource({...});
 *   const handleCreateEvent = createHandler(eventsResource, {
 *     onSuccess: () => redirect('/admin/'),
 *     onError: (error) => htmlResponse(createPage(error), 400),
 *   });
 */

import {
  type AuthFormResult,
  type AuthSession,
  requireAuthForm,
} from "#routes/utils.ts";
import type { CreateResult, Resource } from "./resource.ts";

/** Async or sync response */
type MaybeAsync<T> = T | Promise<T>;

/** Auth context from successful check */
type AuthOk = AuthFormResult & { ok: true };

/** Callback for validation errors */
type OnError = (
  error: string,
  session: AuthSession,
  form: URLSearchParams,
) => MaybeAsync<Response>;

/** Callback for row success */
type OnRowSuccess<R> = (row: R, session: AuthSession) => MaybeAsync<Response>;

/** Options for create handler */
export interface CreateHandlerOptions<R> {
  onSuccess: OnRowSuccess<R>;
  onError: OnError;
}

/** Options for update handler - extends create with onNotFound */
export interface UpdateHandlerOptions<R> extends CreateHandlerOptions<R> {
  onNotFound: () => MaybeAsync<Response>;
}

/** Dispatch create result */
const dispatchCreate = <R>(
  result: CreateResult<R>,
  auth: AuthOk,
  opts: CreateHandlerOptions<R>,
): MaybeAsync<Response> =>
  result.ok
    ? opts.onSuccess(result.row, auth.session)
    : opts.onError(result.error, auth.session, auth.form);

/** Create POST handler */
export const createHandler =
  <R, I>(resource: Resource<R, I>, opts: CreateHandlerOptions<R>) =>
  async (request: Request): Promise<Response> => {
    const a = await requireAuthForm(request);
    return a.ok
      ? dispatchCreate(await resource.create(a.form), a, opts)
      : a.response;
  };
