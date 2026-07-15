import {
  createConfirmedHandlers,
  type FormGuard,
} from "#routes/admin/confirmation.ts";
import {
  AUTH_FORM,
  authPage,
  CONTENT_FORM,
  OWNER_FORM,
  requireContentOr,
  requireOwnerOr,
  requireSessionOr,
  type SessionGuard,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
/* jscpd:ignore-start */
import { type IdRouteHandler, idRouteFor, withEntity } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
/* jscpd:ignore-end */
import { logActivity } from "#shared/db/activityLog.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import type { NamedResource } from "#shared/rest/resource.ts";
import type { AdminSession } from "#shared/types.ts";

/**
 * `Row` is the stored row the resource writes and the edit/delete pages load via
 * `table.findById`; `Display` is the (optionally richer) row the list page
 * renders. They differ only when a list column is projected at read time rather
 * than stored — e.g. modifiers, whose `total_revenue` is a ledger projection
 * absent from the stored {@link ModifierRow} but present on the displayed
 * {@link Modifier}. `Display` defaults to `Row`, so the common case (groups,
 * holidays, …) is unchanged.
 */
type CrudConfig<Row, Input, Display = Row> = {
  singular: string;
  listPath: string;
  /** Redirect path after create/edit. Falls back to listPath when not provided.
   * Receives the acting session so the target can be role-aware (e.g. editors,
   * who can't open the staff detail page, return to the edit form instead). */
  getRowPath?: (row: Row, session: AdminSession) => string;
  getAll: () => Promise<Display[]>;
  /** The resource, or a factory that builds it. A factory lets a resource whose
   * fields are a per-request builder (e.g. modifiers, whose picklist options
   * resolve through `t()`) stay off the module-load / cold-start path — it is
   * only invoked inside the per-request handlers below, never at setup. */
  resource: NamedResource<Row, Input> | (() => NamedResource<Row, Input>);
  renderList: (
    rows: Display[],
    session: AdminSession,
    successMessage?: string,
  ) => string;
  renderNew: (session: AdminSession, error?: string) => string;
  renderEdit?: (row: Row, session: AdminSession, error?: string) => string;
  renderDelete: (row: Row, session: AdminSession, error?: string) => string;
  getName: (row: Row) => string;
  /** Optional delete guard: a returned message blocks the deletion and renders
   * on the confirmation page (see confirmation.ts `guardError`). */
  deleteGuard?: (row: Row, id: number) => Promise<string | null>;
};

type AuthGuards = {
  requireSession: SessionGuard<AdminSession>;
  withForm: FormGuard<AdminSession>;
};

/** Create CRUD handlers that require owner role */
export const createOwnerCrudHandlers = createCrudHandlersWithAuth({
  requireSession: requireOwnerOr,
  withForm: (r, h) => withAuth(r, OWNER_FORM, h),
});

/** Create CRUD handlers accessible to any authenticated admin (owner or manager) */
export const createCrudHandlers = createCrudHandlersWithAuth({
  requireSession: requireSessionOr,
  withForm: (r, h) => withAuth(r, AUTH_FORM, h),
});

/** Create CRUD handlers accessible to content roles (owner, manager, editor).
 * Used for the listing/group create/edit pages editors share; callers that must
 * keep destructive deletes staff-only assemble routes by hand, taking the
 * read/write handlers from here and the delete routes from a staff CRUD. */
export const createContentCrudHandlers = createCrudHandlersWithAuth({
  requireSession: requireContentOr,
  withForm: (r, h) => withAuth(r, CONTENT_FORM, h),
});

function createCrudHandlersWithAuth(auth: AuthGuards) {
  return <Row, Input, Display = Row>(cfg: CrudConfig<Row, Input, Display>) => {
    type FormHandler = ResponseHandler<
      [session: AdminSession, form: FormParams]
    >;

    // Resolve the resource per-request. When `cfg.resource` is a factory, this
    // defers building its fields until a handler actually runs (see the type
    // note above); an already-built resource is returned as-is.
    const resource = (): NamedResource<Row, Input> =>
      typeof cfg.resource === "function" ? cfg.resource() : cfg.resource;

    const authForm =
      (handler: FormHandler) =>
      (request: Request): Promise<Response> =>
        auth.withForm(request, handler);

    const authHtml = authPage(auth.requireSession);

    const authRowHtml =
      (
        render: (row: Row, session: AdminSession, error?: string) => string,
      ): IdRouteHandler =>
      (request, { id }) =>
        auth.requireSession(request, (session) => {
          const flash = applyFlash(request);
          return withEntity<Row>((row) =>
            htmlResponse(render(row, session, flash.error)),
          )(() => resource().table.findById(id));
        });

    const logAndRedirect = async (
      verb: string,
      row: Row,
      session: AdminSession,
    ): Promise<Response> => {
      await logActivity(`${cfg.singular} '${cfg.getName(row)}' ${verb}`);
      return redirect(
        cfg.getRowPath?.(row, session) ?? cfg.listPath,
        `${cfg.singular} ${verb}`,
        true,
      );
    };

    const listGet = authHtml(async (session) => {
      const rows = await cfg.getAll();
      const success = getFlash().success;
      return cfg.renderList(rows, session, success);
    });

    // Surface a validation error stashed by a failed create (PRG redirect),
    // mirroring how listGet reads the success flash. Without this the create
    // page would silently re-render blank after rejecting a submission.
    const newGet = authHtml((session) =>
      cfg.renderNew(session, getFlash().error),
    );

    const createHandler: FormHandler = async (session, form) => {
      const result = await resource().create(form);
      return result.ok
        ? await logAndRedirect("created", result.row, session)
        : errorRedirect(`${cfg.listPath}/new`, result.error);
    };

    const createPost = authForm(createHandler);

    const editGet = cfg.renderEdit ? authRowHtml(cfg.renderEdit) : undefined;

    const editPost: IdRouteHandler = (request, { id }) =>
      auth.withForm(request, async (session, form) => {
        const result = await resource().update(id, form);
        if (result.ok) {
          return logAndRedirect("updated", result.row, session);
        }
        if ("notFound" in result) return notFoundResponse();
        return errorRedirect(`${cfg.listPath}/${id}/edit`, result.error);
      });

    const confirmedDelete = createConfirmedHandlers<Row, AdminSession>({
      auth: { requireSession: auth.requireSession, withForm: auth.withForm },
      ...(cfg.deleteGuard
        ? { guardError: (row: Row, id: number) => cfg.deleteGuard!(row, id) }
        : {}),
      identifier: cfg.getName,
      identifierLabel: `${cfg.singular} name`,
      load: (id) => resource().table.findById(id),
      onConfirm: async (row, id) => {
        await resource().delete(id);
        await logActivity(`${cfg.singular} '${cfg.getName(row)}' deleted`);
      },
      path: `${cfg.listPath}/:id/delete`,
      render: cfg.renderDelete,
      successMessage: `${cfg.singular} deleted`,
      successRedirect: cfg.listPath,
    });

    return {
      createPost,
      deleteGet: idRouteFor(confirmedDelete.get),
      deletePost: idRouteFor(confirmedDelete.post),
      editGet,
      editPost,
      listGet,
      newGet,
    };
  };
}
