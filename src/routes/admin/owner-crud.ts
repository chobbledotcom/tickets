import { logActivity } from "#lib/db/activityLog.ts";
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { NamedResource } from "#lib/rest/resource.ts";
import type { AdminSession } from "#lib/types.ts";
import {
  createConfirmedHandlers,
  type FormGuard,
  type SessionGuard,
} from "#routes/admin/utils.ts";
import {
  AUTH_FORM,
  applyFlash,
  errorRedirect,
  htmlResponse,
  type IdRouteHandler,
  notFoundResponse,
  OWNER_FORM,
  orNotFound,
  redirect,
  requireOwnerOr,
  requireSessionOr,
  withAuth,
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
) =>
  createCrudHandlersWithAuth(cfg, {
    requireSession: requireOwnerOr,
    withForm: (r, h) => withAuth(r, OWNER_FORM, h),
  });

/** Create CRUD handlers accessible to any authenticated admin (owner or manager) */
export const createCrudHandlers = <Row, Input>(cfg: CrudConfig<Row, Input>) =>
  createCrudHandlersWithAuth(cfg, {
    requireSession: requireSessionOr,
    withForm: (r, h) => withAuth(r, AUTH_FORM, h),
  });

type AuthGuards = {
  requireSession: SessionGuard<AdminSession>;
  withForm: FormGuard<AdminSession>;
};

const createCrudHandlersWithAuth = <Row, Input>(
  cfg: CrudConfig<Row, Input>,
  auth: AuthGuards,
) => {
  type FormHandler = (
    session: AdminSession,
    form: FormParams,
  ) => Response | Promise<Response>;

  const authForm =
    (handler: FormHandler) =>
    (request: Request): Promise<Response> =>
      auth.withForm(request, handler);

  const authHtml =
    (render: (session: AdminSession) => string | Promise<string>) =>
    (request: Request): Promise<Response> =>
      auth.requireSession(request, async (session) => {
        applyFlash(request);
        return htmlResponse(await render(session));
      });

  const authRowHtml =
    (render: (row: Row, session: AdminSession) => string): IdRouteHandler =>
    (request, { id }) =>
      auth.requireSession(request, (session) => {
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

  const listGet = authHtml(async (session) => {
    const rows = await cfg.getAll();
    const success = getFlash().success;
    return cfg.renderList(rows, session, success);
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
    auth.withForm(request, async (_session, form) => {
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

  const confirmedDelete = createConfirmedHandlers<Row, AdminSession>({
    auth: { requireSession: auth.requireSession, withForm: auth.withForm },
    path: `${cfg.listPath}/:id/delete`,
    load: (id) => cfg.resource.table.findById(id),
    render: cfg.renderDelete,
    identifier: cfg.getName,
    onConfirm: async (row, id) => {
      await cfg.resource.delete(id);
      await logActivity(`${cfg.singular} '${cfg.getName(row)}' deleted`);
    },
    successRedirect: cfg.listPath,
    successMessage: `${cfg.singular} deleted`,
    identifierLabel: `${cfg.singular} name`,
  });

  return {
    listGet,
    newGet,
    createPost,
    editGet,
    editPost,
    deleteRoutes: confirmedDelete.routes,
  };
};
