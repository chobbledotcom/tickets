/**
 * REST route handler factories - integrates auth/CSRF with resource operations.
 *
 * Usage:
 *   const eventsResource = defineResource({...});
 *   const handleCreateEvent = createHandler(eventsResource, {
 *     onSuccess: () => redirect('/admin/'),
 *     onError: (error) => htmlResponse(createPage(error), 400),
 *   });
 *   const handleDeleteEvent = deleteHandler(eventsResource, {
 *     onSuccess: () => redirect('/admin/'),
 *     onNotFound: () => htmlResponse(notFoundPage(), 404),
 *   });
 */

import type { InValue } from "@libsql/client";
import {
  type AuthFormResult,
  type AuthSession,
  requireAuthForm,
} from "#routes/utils.ts";
import type { CreateResult, DeleteResult, Resource } from "./resource.ts";

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

/** Options for delete handler */
export interface DeleteHandlerOptions<R> {
  onSuccess: (session: AuthSession) => MaybeAsync<Response>;
  onVerifyFailed?: (
    r: R,
    s: AuthSession,
    f: URLSearchParams,
  ) => MaybeAsync<Response>;
  onNotFound: () => MaybeAsync<Response>;
}

/** Handler taking request and optional id */
type IdHandler = (req: Request, id: InValue) => Promise<Response>;

/** Require auth and dispatch with ID */
const authHandler =
  (
    handler: (req: Request, id: InValue, auth: AuthOk) => MaybeAsync<Response>,
  ): IdHandler =>
  async (req, id) => {
    const a = await requireAuthForm(req);
    return a.ok ? handler(req, id, a) : a.response;
  };

/** Dispatch create result */
const dispatchCreate = <R>(
  result: CreateResult<R>,
  auth: AuthOk,
  opts: CreateHandlerOptions<R>,
): MaybeAsync<Response> =>
  result.ok
    ? opts.onSuccess(result.row, auth.session)
    : opts.onError(result.error, auth.session, auth.form);

/** Dispatch delete result */
const dispatchDelete = <R>(
  result: DeleteResult,
  session: AuthSession,
  opts: Pick<DeleteHandlerOptions<R>, "onSuccess" | "onNotFound">,
): MaybeAsync<Response> =>
  result.ok || !("notFound" in result)
    ? opts.onSuccess(session)
    : opts.onNotFound();

/** Create POST handler */
export const createHandler =
  <R, I>(resource: Resource<R, I>, opts: CreateHandlerOptions<R>) =>
  async (request: Request): Promise<Response> => {
    const a = await requireAuthForm(request);
    return a.ok
      ? dispatchCreate(await resource.create(a.form), a, opts)
      : a.response;
  };

/** Check name verification param */
const needsVerify = (req: Request): boolean =>
  new URL(req.url).searchParams.get("verify_name") !== "false";

/** Verify name or return error */
const verifyOrError = <R, I>(
  req: Request,
  res: Resource<R, I>,
  row: R,
  auth: AuthOk,
  onFail?: DeleteHandlerOptions<R>["onVerifyFailed"],
): MaybeAsync<Response> | null => {
  if (!needsVerify(req) || !res.verifyName || !onFail) return null;
  const name = auth.form.get("confirm_name") ?? "";
  return res.verifyName(row, name)
    ? null
    : onFail(row, auth.session, auth.form);
};

/** Create DELETE handler with optional name verification */
export const deleteHandler = <R, I>(
  resource: Resource<R, I>,
  opts: DeleteHandlerOptions<R>,
): IdHandler =>
  authHandler(async (req, id, auth) => {
    const row = await resource.table.findById(id);
    if (!row) return opts.onNotFound();
    const err = verifyOrError(req, resource, row, auth, opts.onVerifyFailed);
    if (err) return err;
    return dispatchDelete(await resource.delete(id), auth.session, opts);
  });
