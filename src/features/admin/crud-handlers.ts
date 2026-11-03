/* jscpd:ignore-end */
import { logActivity } from "#db/activity-log.ts";
import {
  createConfirmedHandlers,
  type FormGuard,
} from "#routes/admin/confirmation.ts";
import type { EditErrorRenderer } from "#routes/admin/entity-write-tab.ts";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import {
  type AuthSession,
  authPage,
  formPolicyFor,
  pageGuardFor,
  type SessionGuard,
  withAuth,
} from "#routes/auth.ts";
/* jscpd:ignore-start */
import { type IdRouteHandler, idRouteFor } from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { afterSavePath } from "#shared/admin-pages.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminDestinationAt } from "#shared/admin-surface.ts";
import { getFlash } from "#shared/flash-context.ts";
import type {
  DeleteResult,
  NamedOperations,
  UpdateResult,
} from "#shared/rest/resource.ts";
import type { AdminSession } from "#types";

type OperationFailure = Exclude<
  DeleteResult | UpdateResult<unknown>,
  { ok: true }
>;

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
 * `Row` is the stored row the resource writes. `Display` is the optionally
 * richer row the list page renders. They differ only when a list column is
 * projected at read time rather than stored. An example is modifiers, whose
 * `total_revenue` is a ledger projection. It is absent from the stored
 * {@link ModifierRow} and present on the displayed {@link Modifier}.
 * `Display` defaults to `Row`, so the common case (groups, holidays, …) is
 * unchanged.
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
  /** The collection's own route. Its path gives the five routes beneath it,
   * and each of those declares the roles that reach it and the page its save
   * lands on. */
  list: AdminDestinationId;
  getAll: () => Promise<Display[]>;
  /** The resource, or a factory that builds it. A factory keeps a resource
   * whose fields are a per-request builder off the module-load path. Modifiers
   * are the example: their picklist options resolve through `t()`. The factory
   * is only invoked inside the per-request handlers below, never at setup. */
  operations: NamedOperations<Row> | (() => NamedOperations<Row>);
  /** Render a rejected edit in place. Entity pages use this to preserve the
   * submitted values at status 400. */
  renderEditError?: EditErrorRenderer;
  renderDelete: (row: Row, session: AdminSession, error?: string) => string;
  getName: (row: Row) => string;
  activityName?: string;
  identifierLabel: string;
  /** Optional delete guard: a returned message blocks the deletion and renders
   * on the confirmation page (see confirmation.ts `guardError`). */
  deleteGuard?: (row: Row, id: number) => Promise<string | null>;
};

/** The gates the six standard routes run, each from the route it guards.
 * A collection whose deletes are staff-only while its edits admit editors
 * needs no second bundle: each route already declares its own roles. */
type CrudGates = {
  create: FormGuard<AuthSession>;
  delete: SessionGuard<AuthSession>;
  deleteForm: FormGuard<AuthSession>;
  edit: FormGuard<AuthSession>;
  list: SessionGuard<AuthSession>;
  new: SessionGuard<AuthSession>;
};

const formGuardAt = (pattern: string): FormGuard<AuthSession> => {
  const policy = formPolicyFor(adminDestinationAt(pattern));
  return (request, handle) => withAuth(request, policy, handle);
};

const pageGuardAt = (pattern: string): SessionGuard<AuthSession> =>
  pageGuardFor(adminDestinationAt(pattern));

const crudGates = (listPath: string): CrudGates => {
  const deletePath = `${listPath}/:id/delete`;
  return {
    create: formGuardAt(`${listPath}/new`),
    delete: pageGuardAt(deletePath),
    deleteForm: formGuardAt(deletePath),
    edit: formGuardAt(`${listPath}/:id/edit`),
    list: pageGuardAt(listPath),
    new: pageGuardAt(`${listPath}/new`),
  };
};

/**
 * Create the six standard CRUD handlers for one collection. Every gate comes
 * from the route it guards, so the roles are written once, in the admin
 * surface declaration, and never again beside the handlers.
 */
export const createCrudHandlers = <Row extends { id: number }, Display = Row>(
  cfg: CrudConfig<Row, Display>,
): CrudHandlers => {
  const listRoute = adminDestination(cfg.list);
  const listPath = listRoute.pattern;
  // The edit form's own route names the page a save lands on. A collection
  // whose edits return to its list declares it there, beside the route.
  const editRoute = adminDestinationAt(`${listPath}/:id/edit`);
  // Resolve the landing at setup, so a collection that declares none fails
  // here rather than one save after it already wrote the row.
  if (editRoute.afterSave === undefined) {
    throw new Error(
      `Admin route "${editRoute.id}" declares no after-save landing`,
    );
  }
  const auth = crudGates(listPath);
  const operations = (): NamedOperations<Row> =>
    typeof cfg.operations === "function" ? cfg.operations() : cfg.operations;
  const activityName =
    cfg.activityName === undefined ? cfg.singular : cfg.activityName;
  const logAndRedirect = async (
    verb: string,
    row: Row,
    landing: string,
  ): Promise<Response> => {
    await logActivity(`${activityName} '${cfg.getName(row)}' ${verb}`);
    return redirect(landing, `${cfg.singular} ${verb}`, true);
  };

  const listGet = authPage(auth.list)(async (session) =>
    cfg.renderList(await cfg.getAll(), session, getFlash().success),
  );

  // Surface a validation error stashed by a failed create (PRG redirect),
  // mirroring how listGet reads the success flash. Without this the create
  // page silently re-renders blank after rejecting a submission.
  const newGet = authPage(auth.new)((session) =>
    cfg.renderNew(session, getFlash().error),
  );

  const formPost =
    (guard: FormGuard<AuthSession>) =>
    (handle: Parameters<FormGuard<AuthSession>>[1]) =>
    (request: Request): Promise<Response> =>
      guard(request, handle);
  const createPost = formPost(auth.create)(async (_session, form) => {
    const result = await operations().create(form);
    if (!result.ok) return errorRedirect(`${listPath}/new`, result.error);
    // The create form saves on the list page, so it returns there unless that
    // page's declaration names the new record's page instead.
    return logAndRedirect(
      "created",
      result.row,
      listRoute.afterSave === undefined
        ? listPath
        : afterSavePath(listRoute, result.row.id),
    );
  });

  const editPost: IdRouteHandler = (request, { id }) =>
    formPost(auth.edit)(async (session, form) => {
      const result = await operations().update(id, form);
      return operationResponse(
        result,
        ({ row }) =>
          logAndRedirect("updated", row, afterSavePath(editRoute, row.id)),
        (error) =>
          cfg.renderEditError
            ? cfg.renderEditError(id, session, form, error)
            : errorRedirect(`${listPath}/${id}/edit`, error),
      );
    })(request);

  const confirmedDelete = createConfirmedHandlers<Row, AdminSession>({
    auth: { requireSession: auth.delete, withForm: auth.deleteForm },
    ...(cfg.deleteGuard
      ? { guardError: (row: Row, id: number) => cfg.deleteGuard!(row, id) }
      : {}),
    identifier: cfg.getName,
    identifierLabel: cfg.identifierLabel,
    load: (id) => operations().loadOrNull(id),
    onConfirm: async (row, id, _session, form) => {
      const result = await operations().delete(id, form);
      return operationResponse(
        result,
        async (): Promise<undefined> => {
          await logActivity(`${activityName} '${cfg.getName(row)}' deleted`);
        },
        (error) => errorRedirect(`${listPath}/${id}/delete`, error),
      );
    },
    path: `${listPath}/:id/delete`,
    render: cfg.renderDelete,
    successMessage: `${cfg.singular} deleted`,
    successRedirect: listPath,
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
