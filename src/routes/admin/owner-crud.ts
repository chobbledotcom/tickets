import { logActivity } from "#lib/db/activityLog.ts";
import type { NamedResource } from "#lib/rest/resource.ts";
import type { AdminSession } from "#lib/types.ts";
import {
  getSearchParam,
  htmlResponse,
  type IdRouteHandler,
  notFoundResponse,
  orNotFound,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";

type OwnerCrudConfig<Row, Input> = {
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
  deleteConfirmError: string;
};

export const createOwnerCrudHandlers = <Row, Input>(
  cfg: OwnerCrudConfig<Row, Input>,
) => {
  type OwnerFormHandler = (
    session: AdminSession,
    form: URLSearchParams,
  ) => Response | Promise<Response>;

  const ownerForm =
    (handler: OwnerFormHandler) =>
    (request: Request): Promise<Response> =>
      withOwnerAuthForm(request, handler);

  const ownerHtml =
    (render: (session: AdminSession) => string | Promise<string>) =>
    (request: Request): Promise<Response> =>
      requireOwnerOr(request, async (session) =>
        htmlResponse(await render(session)),
      );

  const ownerRowHtml =
    (render: (row: Row, session: AdminSession) => string): IdRouteHandler =>
    (request, { id }) =>
      requireOwnerOr(request, (session) =>
        orNotFound(cfg.resource.table.findById(id), (row) =>
          htmlResponse(render(row, session)),
        ),
      );

  const logAndRedirect = async (
    verb: string,
    name: string,
    path?: string,
  ): Promise<Response> => {
    await logActivity(`${cfg.singular} '${name}' ${verb}`);
    return redirect(path ?? cfg.listPath, `${cfg.singular} ${verb}`, true);
  };

  const listGet = (request: Request): Promise<Response> =>
    requireOwnerOr(request, async (session) => {
      const rows = await cfg.getAll();
      const success = getSearchParam(request, "success") || undefined;
      return htmlResponse(cfg.renderList(rows, session, success));
    });

  const newGet = ownerHtml(cfg.renderNew);

  const createHandler: OwnerFormHandler = async (session, form) => {
    const result = await cfg.resource.create(form);
    return result.ok
      ? await logAndRedirect(
          "created",
          cfg.getName(result.row),
          cfg.getRowPath?.(result.row),
        )
      : htmlResponse(cfg.renderNew(session, result.error), 400);
  };

  const createPost = ownerForm(createHandler);

  const editGet = ownerRowHtml(cfg.renderEdit);

  const editPost: IdRouteHandler = (request, { id }) =>
    withOwnerAuthForm(request, async (session, form) => {
      const result = await cfg.resource.update(id, form);
      if (result.ok) {
        return logAndRedirect(
          "updated",
          cfg.getName(result.row),
          cfg.getRowPath?.(result.row),
        );
      }
      if ("notFound" in result) return notFoundResponse();
      return orNotFound(cfg.resource.table.findById(id), (row) =>
        htmlResponse(cfg.renderEdit(row, session, result.error), 400),
      );
    });

  const deleteGet = ownerRowHtml(cfg.renderDelete);

  const deletePost: IdRouteHandler = (request, { id }) =>
    withOwnerAuthForm(request, (session, form) =>
      orNotFound(cfg.resource.table.findById(id), async (row) => {
        const confirm = String(form.get("confirm_identifier"));
        const nameMatches = cfg.resource.verifyName(row, confirm);

        if (!nameMatches) {
          return htmlResponse(
            cfg.renderDelete(row, session, cfg.deleteConfirmError),
            400,
          );
        }

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
