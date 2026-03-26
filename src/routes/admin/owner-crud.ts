import { logActivity } from "#lib/db/activityLog.ts";
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { NamedResource } from "#lib/rest/resource.ts";
import type { AdminSession } from "#lib/types.ts";
import { verifyOrRedirect } from "#routes/admin/utils.ts";
import {
  applyFlash,
  errorRedirect,
  htmlResponse,
  type IdRouteHandler,
  notFoundResponse,
  orNotFound,
  redirect,
  requireOwnerOr,
  requireSessionOr,
  withAuthForm,
  withOwnerAuthForm,
} from "#routes/utils.ts";

type CrudConfig<Row, Input> = {
  singular: string;
  listPath: string;
  /** Redirect path after create/edit. Falls back to listPath when not provided. */
  getRowPath?: (row: Row) => string;
  getAll: () => Promise<Row[]>;
  resource: NamedResource<Row, Input>;
  renderList: (
    rows: Row[],
    session: AdminSession,
    successMessage?: string,
  ) => string;
  renderNew: (session: AdminSession, error?: string) => string;
  renderEdit: (row: Row, session: AdminSession, error?: string) => string;
  renderDelete: (row: Row, session: AdminSession, error?: string) => string;
  getName: (row: Row) => string;
};

/** Create CRUD handlers that require owner role */
export const createOwnerCrudHandlers = <Row, Input>(
  cfg: CrudConfig<Row, Input>,
) => createCrudHandlersWithAuth(cfg, requireOwnerOr, withOwnerAuthForm);

/** Create CRUD handlers accessible to any authenticated admin (owner or manager) */
export const createCrudHandlers = <Row, Input>(cfg: CrudConfig<Row, Input>) =>
  createCrudHandlersWithAuth(cfg, requireSessionOr, withAuthForm);

type AuthGuard = (
  request: Request,
  handler: (session: AdminSession) => Response | Promise<Response>,
) => Promise<Response>;

type FormGuard = (
  request: Request,
  handler: (
    session: AdminSession,
    form: FormParams,
  ) => Response | Promise<Response>,
) => Promise<Response>;

const createCrudHandlersWithAuth = <Row, Input>(
  cfg: CrudConfig<Row, Input>,
  requireAuth: AuthGuard,
  withFormAuth: FormGuard,
) => {
  type FormHandler = (
    session: AdminSession,
    form: FormParams,
  ) => Response | Promise<Response>;

  const authForm =
    (handler: FormHandler) =>
    (request: Request): Promise<Response> =>
      withFormAuth(request, handler);

  const authHtml =
    (render: (session: AdminSession) => string | Promise<string>) =>
    (request: Request): Promise<Response> =>
      requireAuth(request, async (session) => {
        applyFlash(request);
        return htmlResponse(await render(session));
      });

  const authRowHtml =
    (render: (row: Row, session: AdminSession) => string): IdRouteHandler =>
    (request, { id }) =>
      requireAuth(request, (session) => {
        applyFlash(request);
        return orNotFound(cfg.resource.table.findById(id), (row) =>
          htmlResponse(render(row, session)),
        );
      });

  const logAndRedirect = async (
    verb: string,
    name: string,
    path?: string,
  ): Promise<Response> => {
    await logActivity(`${cfg.singular} '${name}' ${verb}`);
    return redirect(path ?? cfg.listPath, `${cfg.singular} ${verb}`, true);
  };

  const listGet = (request: Request): Promise<Response> =>
    requireAuth(request, async (session) => {
      const rows = await cfg.getAll();
      const success = getFlash().success;
      return htmlResponse(cfg.renderList(rows, session, success));
    });

  const newGet = authHtml(cfg.renderNew);

  const createHandler: FormHandler = async (_session, form) => {
    const result = await cfg.resource.create(form);
    return result.ok
      ? await logAndRedirect(
          "created",
          cfg.getName(result.row),
          cfg.getRowPath?.(result.row),
        )
      : errorRedirect(`${cfg.listPath}/new`, result.error);
  };

  const createPost = authForm(createHandler);

  const editGet = authRowHtml(cfg.renderEdit);

  const editPost: IdRouteHandler = (request, { id }) =>
    withFormAuth(request, async (_session, form) => {
      const result = await cfg.resource.update(id, form);
      if (result.ok) {
        return logAndRedirect(
          "updated",
          cfg.getName(result.row),
          cfg.getRowPath?.(result.row),
        );
      }
      if ("notFound" in result) return notFoundResponse();
      return errorRedirect(`${cfg.listPath}/${id}/edit`, result.error);
    });

  const deleteGet = authRowHtml(cfg.renderDelete);

  const deletePost: IdRouteHandler = (request, { id }) =>
    withFormAuth(request, (_session, form) =>
      orNotFound(cfg.resource.table.findById(id), async (row) => {
        const error = verifyOrRedirect(
          form,
          cfg.getName(row),
          `${cfg.listPath}/${id}/delete`,
          `${cfg.singular} name`,
          "deletion",
        );
        if (error) return error;

        const result = await cfg.resource.delete(id);
        if ("notFound" in result) return notFoundResponse();
        await logActivity(`${cfg.singular} '${cfg.getName(row)}' deleted`);
        return redirect(cfg.listPath, `${cfg.singular} deleted`, true);
      }),
    );

  return {
    listGet,
    newGet,
    createPost,
    editGet,
    editPost,
    deleteGet,
    deletePost,
  };
};
