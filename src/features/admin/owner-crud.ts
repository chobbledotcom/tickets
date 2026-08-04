import {
  createConfirmedHandlers,
  type FormGuard,
} from "#routes/admin/confirmation.ts";
import type { EditErrorRenderer } from "#routes/admin/entity-write-tab.ts";
import {
  AUTH_FORM,
  type AuthSession,
  authPage,
  CONTENT_FORM,
  OWNER_FORM,
  requireContentOr,
  requireOwnerOr,
  requireSessionOr,
  type SessionGuard,
  withAuth,
} from "#routes/auth.ts";
/* jscpd:ignore-start */
import { type IdRouteHandler, idRouteFor } from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { logActivity } from "#shared/db/activityLog.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import type {
  DeleteResult,
  NamedOperations,
  UpdateResult,
} from "#shared/rest/resource.ts";
import type { AdminSession } from "#shared/types.ts";

type OperationFailure = Exclude<
  DeleteResult | UpdateResult<unknown>,
  { ok: true }
>;

/** The handler bundle a CRUD factory returns, bindable via
 * {@link crudRoutes} or one key at a time. */
export interface CrudHandlers {
  createPost: RequestRoute;
  deleteGet: IdRouteHandler;
  deletePost: IdRouteHandler;
  editPost: IdRouteHandler;
  listGet: RequestRoute;
  newGet: RequestRoute;
}

/** The six routes a standard CRUD section binds. */
export type CrudRoutes<Base extends string> = {
  [K in
    | `GET ${Base}`
    | `GET ${Base}/new`
    | `GET ${Base}/:id/delete`
    | `POST ${Base}`
    | `POST ${Base}/:id/delete`
    | `POST ${Base}/:id/edit`]: TypedRouteHandler<K>;
};

/** Bind a CRUD handler bundle under its section's six standard routes, ready
 * to spread into the route table. A section with a bespoke step spreads this
 * first and restates just that key (e.g. a custom `:id/edit` POST). */
export const crudRoutes = <Base extends string>(
  base: Base,
  crud: CrudHandlers,
): CrudRoutes<Base> =>
  ({
    [`GET ${base}`]: crud.listGet,
    [`GET ${base}/new`]: crud.newGet,
    [`GET ${base}/:id/delete`]: crud.deleteGet,
    [`POST ${base}`]: crud.createPost,
    [`POST ${base}/:id/delete`]: crud.deletePost,
    [`POST ${base}/:id/edit`]: crud.editPost,
    // Computed template-literal keys widen to an index signature, so the
    // literal route keys are restated by the cast.
  }) as CrudRoutes<Base>;

/** Resolve one CRUD operation through its success or failure response path. */
export const operationResponse = async <Success extends { ok: true }, Output>(
  result: Success | OperationFailure,
  onSuccess: (result: Success) => Output | Promise<Output>,
  renderError: (error: string) => Response | Promise<Response>,
): Promise<Output | Response> =>
  result.ok
    ? onSuccess(result)
    : "notFound" in result
      ? notFoundResponse()
      : renderError(result.error);

/**
 * `Row` is the stored row the resource writes; `Display` is the (optionally
 * richer) row the list page
 * renders. They differ only when a list column is projected at read time rather
 * than stored — e.g. modifiers, whose `total_revenue` is a ledger projection
 * absent from the stored {@link ModifierRow} but present on the displayed
 * {@link Modifier}. `Display` defaults to `Row`, so the common case (groups,
 * holidays, …) is unchanged.
 */
export type CollectionRenderers<Model> = {
  renderList: (
    rows: Model,
    session: AdminSession,
    successMessage?: string,
  ) => string;
  renderNew: (session: AdminSession, error?: string) => string;
};

type CrudConfig<Row, Display = Row> = CollectionRenderers<Display[]> & {
  singular: string;
  listPath: string;
  /** Redirect path after create/edit. Falls back to listPath when not provided.
   * Receives the acting session so the target can be role-aware (e.g. editors,
   * who can't open the staff detail page, return to the edit form instead). */
  getRowPath?: (row: Row, session: AdminSession) => string;
  /** Optional create-only target. This supports resources whose new records
   * return to the collection while edits open the canonical entity page. */
  getCreatePath?: (row: Row, session: AdminSession) => string;
  getAll: () => Promise<Display[]>;
  /** The resource, or a factory that builds it. A factory lets a resource whose
   * fields are a per-request builder (e.g. modifiers, whose picklist options
   * resolve through `t()`) stay off the module-load / cold-start path — it is
   * only invoked inside the per-request handlers below, never at setup. */
  operations: NamedOperations<Row> | (() => NamedOperations<Row>);
  /** Render a rejected edit in place. Entity pages use this to preserve the
   * submitted values at status 400. */
  renderEditError?: EditErrorRenderer;
  renderDelete: (row: Row, session: AdminSession, error?: string) => string;
  getName: (row: Row) => string;
  activityName?: string;
  identifierLabel?: string;
  /** Optional delete guard: a returned message blocks the deletion and renders
   * on the confirmation page (see confirmation.ts `guardError`). */
  deleteGuard?: (row: Row, id: number) => Promise<string | null>;
};

type AuthGuards = {
  requireSession: SessionGuard<AuthSession>;
  withForm: FormGuard<AuthSession>;
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
  return <Row, Display = Row>(cfg: CrudConfig<Row, Display>): CrudHandlers => {
    const operations = (): NamedOperations<Row> =>
      typeof cfg.operations === "function" ? cfg.operations() : cfg.operations;
    const activityName =
      cfg.activityName === undefined ? cfg.singular : cfg.activityName;
    const authHtml = authPage(auth.requireSession);
    const logAndRedirect = async (
      verb: string,
      row: Row,
      session: AuthSession,
      getPath = cfg.getRowPath,
    ): Promise<Response> => {
      await logActivity(`${activityName} '${cfg.getName(row)}' ${verb}`);
      return redirect(
        getPath === undefined ? cfg.listPath : getPath(row, session),
        `${cfg.singular} ${verb}`,
        true,
      );
    };

    const listGet = authHtml(async (session) =>
      cfg.renderList(await cfg.getAll(), session, getFlash().success),
    );

    // Surface a validation error stashed by a failed create (PRG redirect),
    // mirroring how listGet reads the success flash. Without this the create
    // page would silently re-render blank after rejecting a submission.
    const newGet = authHtml((session) =>
      cfg.renderNew(session, getFlash().error),
    );

    const formPost =
      (handle: Parameters<typeof auth.withForm>[1]) =>
      (request: Request): Promise<Response> =>
        auth.withForm(request, handle);
    const createPost = formPost(async (session, form) => {
      const result = await operations().create(form);
      if (!result.ok) return errorRedirect(`${cfg.listPath}/new`, result.error);
      return logAndRedirect("created", result.row, session, cfg.getCreatePath);
    });

    const editPost: IdRouteHandler = (request, { id }) =>
      formPost(async (session, form) => {
        const result = await operations().update(id, form);
        return operationResponse(
          result,
          ({ row }) => logAndRedirect("updated", row, session),
          (error) =>
            cfg.renderEditError
              ? cfg.renderEditError(id, session, form, error)
              : errorRedirect(`${cfg.listPath}/${id}/edit`, error),
        );
      })(request);

    const confirmedDelete = createConfirmedHandlers<Row, AdminSession>({
      auth: { requireSession: auth.requireSession, withForm: auth.withForm },
      ...(cfg.deleteGuard
        ? { guardError: (row: Row, id: number) => cfg.deleteGuard!(row, id) }
        : {}),
      identifier: cfg.getName,
      identifierLabel:
        cfg.identifierLabel === undefined
          ? `${cfg.singular} name`
          : cfg.identifierLabel,
      load: (id) => operations().loadOrNull(id),
      onConfirm: async (row, id) => {
        const result = await operations().delete(id);
        return operationResponse(
          result,
          async (): Promise<undefined> => {
            await logActivity(`${activityName} '${cfg.getName(row)}' deleted`);
          },
          (error) => errorRedirect(`${cfg.listPath}/${id}/delete`, error),
        );
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
      editPost,
      listGet,
      newGet,
    };
  };
}
