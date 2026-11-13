/**
 * The HTML page routes for one admin record: the six standard routes over the
 * record's single write path.
 *
 * A record module supplies its form, its renderers, and its confirmation
 * words. The audience and the save landing come from the admin surface, so the
 * roles are written once, in `admin-surface/areas.ts`.
 */

import {
  createConfirmedHandlers,
  type FormGuard,
} from "#routes/admin/confirmation.ts";
import type { EditErrorRenderer } from "#routes/admin/entity-write-tab.ts";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import { type AuthSession, authPage, type SessionGuard } from "#routes/auth.ts";
import { type IdRouteHandler, idRouteFor } from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { formGuardAt, pageGuardAt } from "#routes/route-gates.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import {
  adminDestination,
  adminDestinationAtOrNull,
  afterSavePath,
} from "#shared/admin-surface.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import { checkedValues } from "#shared/forms/validation.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import type {
  AdminRecord,
  DeleteVerdict,
  FullRowOf,
  InputOf,
  ListRowOf,
  LoadCommand,
  RecordShape,
  WriteVerdict,
} from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { AdminSession } from "#types";

/** The form facts a page config carries, split out so the parser does not
 *  depend on the renderers. */
type FormInputConfig<CreateValues, EditValues, Input> = {
  form?: FormSchema<CreateValues>;
  /** The edit form, when an edit carries fields a create does not. */
  editForm?: FormSchema<EditValues>;
  /** Convert the validated form values into the record's input. `form` rides
   * along for a field the static schema cannot declare, such as a per-member
   * package price keyed by listing id. */
  toInput?: (values: CreateValues, form: FormParams) => Input | Promise<Input>;
  /** The edit conversion, when an edit builds its input differently from a
   * create (an auto-generated slug becomes a submitted one). */
  toEditInput?: (
    values: EditValues,
    form: FormParams,
  ) => Input | Promise<Input>;
  /** Cross-field form validation, before `toInput`. */
  validateValues?: (values: CreateValues | EditValues) => string | null;
  /** Raw-form validation, before the schema parses it. */
  validateForm?: (form: FormParams) => string | null;
  /** Mutate the form before validation (demo overrides). */
  preprocessForm?: (form: FormParams) => void;
};

/** The destination ids a surface uses for its new, edit, or delete route,
 * when they do not sit under the collection path. */
type RouteOverrides = {
  delete?: AdminDestinationId;
  edit?: AdminDestinationId;
  new?: AdminDestinationId;
};

/** The standard routes a surface does not serve. */
type SkippedRoutes = readonly ("new" | "edit")[];

/** One record's delete-page render. */
type RenderDelete<Shape extends RecordShape> = (
  row: FullRowOf<Shape>,
  session: AdminSession,
  error?: string,
) => string;

/** One record's list-page render. */
type RenderList<Shape extends RecordShape> = (
  rows: ListRowOf<Shape>[],
  session: AdminSession,
  successMessage?: string,
) => string | Promise<string>;

/** The page-door facts a record supplies: its renderers, its form, and its
 * confirmation words. `CreateValues` and `EditValues` are separate because an
 * edit form carries a field a create form does not (the group slug). */
export type RecordPagesConfig<
  Shape extends RecordShape,
  CreateValues,
  EditValues = CreateValues,
  DeleteInput = undefined,
> = FormInputConfig<CreateValues, EditValues, InputOf<Shape>> & {
  renderDelete?: RenderDelete<Shape>;
  renderList?: RenderList<Shape>;
  renderNew?: (session: AdminSession, error?: string) => string;
  /** The noun the flash messages use ("Holiday created"). */
  singular: string;
  routes?: RouteOverrides;
  skip?: SkippedRoutes;
  /** Handlers that replace a generated standard route. */
  overrides?: Partial<CrudHandlers>;
  /** Render a rejected edit in place. Keep the submitted values. */
  renderEditError?: EditErrorRenderer;
  identifierLabel?: string | (() => string);
  /** The display name the confirmation must match. Defaults to the record's
   * display name. A page whose input cannot carry newlines uses the flattened
   * form, which is what the operator can type. */
  identifier?: (row: FullRowOf<Shape>) => string;
  /** The page a refused create returns to. Defaults to the collection's
   * `/new` page. */
  createErrorPath?: string;
  /** The page a save lands on, when the destination table cannot name it (a
   * content record saves back to its Edit tab). */
  savePath?: (id: number) => string;
  /** The page an update lands on, when it differs from the create landing. */
  updateSavePath?: (id: number) => string;
  /** The page a refused edit returns to when it cannot render in place.
   * Defaults to the collection's `/edit` page. */
  editErrorPath?: (id: number) => string;
  /** A pre-render delete guard, shown on the confirmation page. */
  deleteGuard?: (row: FullRowOf<Shape>, id: number) => Promise<string | null>;
  /** The choice the delete command reads from the submitted form. */
  deleteInput?: (form: FormParams) => DeleteInput;
  /** The page a delete lands on, when it is not the collection list. */
  deleteSuccessPath?: string;
  /** The flash a delete answers, when it is not "<singular> deleted". */
  deleteSuccessMessage?: string;
};

/** The gates the six standard routes run, each from the route it guards. */
type RecordGates = {
  create: FormGuard<AuthSession>;
  delete: SessionGuard<AuthSession>;
  deleteForm: FormGuard<AuthSession>;
  edit: FormGuard<AuthSession> | null;
  list: SessionGuard<AuthSession>;
  new: SessionGuard<AuthSession> | null;
};

/** The gate a route declares, or null when the surface declares no route. */
const guardAtOrNull = (
  path: string,
  form: boolean,
): FormGuard<AuthSession> | SessionGuard<AuthSession> | null => {
  if (adminDestinationAtOrNull(path) === null) return null;
  return form ? formGuardAt(path) : pageGuardAt(path);
};

const recordGates = (
  listPath: string,
  newPath: string | null,
  editPath: string | null,
  deletePath: string,
): RecordGates => ({
  create: formGuardAt(listPath),
  delete: pageGuardAt(deletePath),
  deleteForm: formGuardAt(deletePath),
  edit:
    editPath === null
      ? null
      : (guardAtOrNull(editPath, true) as FormGuard<AuthSession>),
  list: pageGuardAt(listPath),
  new:
    newPath === null
      ? null
      : (guardAtOrNull(newPath, false) as SessionGuard<AuthSession>),
});

/** Run the form's own checks, then convert the values to the record's input.
 * The record's one rule runs inside the record's write command. */
const parseFormInput = async <CreateValues, EditValues, Input>(
  config: FormInputConfig<CreateValues, EditValues, Input>,
  form: FormParams,
  edit: boolean,
): Promise<Result<Input>> => {
  config.preprocessForm?.(form);
  const formError = config.validateForm?.(form);
  if (formError) return errorResult(formError);
  if (edit && config.editForm !== undefined) {
    const parsed = checkedValues(
      config.editForm.validate(form),
      config.validateValues,
    );
    if (!parsed.ok) return parsed;
    if (config.toEditInput !== undefined) {
      return okResult(await config.toEditInput(parsed.value, form));
    }
    if (config.toInput === undefined) {
      throw new Error("The record page declares no edit input mapper");
    }
    return okResult(await config.toInput(parsed.value as never, form));
  }
  if (config.form === undefined || config.toInput === undefined) {
    throw new Error("The record page declares no form");
  }
  const parsed = checkedValues(
    config.form.validate(form),
    config.validateValues,
  );
  return parsed.ok
    ? okResult(await config.toInput(parsed.value, form))
    : parsed;
};

/** The refusal answer for a rejected write, or null for a written row. */
const refusalOf = <Row extends { id: number }>(
  verdict: WriteVerdict<Row>,
): string | null => (verdict.kind === "refused" ? verdict.message : null);

const deleteFailure = async (
  verdict: DeleteVerdict,
  deletePath: string,
): Promise<Response | null> =>
  verdict.kind === "refused"
    ? errorRedirect(deletePath, verdict.message)
    : verdict.kind === "not-found"
      ? await notFoundResponse()
      : null;

/** The paths one record's page bundle serves, resolved from the surface and
 *  the config's route overrides. */
type PagePathConfig = {
  createErrorPath?: string;
  routes?: RouteOverrides;
  savePath?: (id: number) => string;
  skip?: SkippedRoutes;
};

type PagePaths = {
  createErrorPath: string;
  deletePath: string;
  editPath: string | null;
  listPath: string;
  newPath: string | null;
  savePath: (id: number) => string;
};

const resolvePagePaths = (
  listPath: string,
  afterSave: string | undefined,
  list: AdminDestinationId,
  config: PagePathConfig,
): PagePaths => {
  const skipped = config.skip ?? [];
  const routePath = <T extends "new" | "edit">(
    kind: T,
    fallback: string,
  ): string | null =>
    skipped.includes(kind)
      ? null
      : config.routes?.[kind]
        ? adminDestination(config.routes[kind]!).pattern
        : adminDestinationAtOrNull(fallback)
          ? fallback
          : null;
  return {
    createErrorPath:
      config.createErrorPath ??
      (config.routes?.new
        ? adminDestination(config.routes.new).pattern
        : `${listPath}/new`),
    deletePath: config.routes?.delete
      ? adminDestination(config.routes.delete).pattern
      : `${listPath}/:id/delete`,
    editPath: routePath("edit", `${listPath}/:id/edit`),
    listPath,
    newPath: routePath("new", `${listPath}/new`),
    savePath: (id) =>
      config.savePath?.(id) ??
      afterSavePath(
        adminDestination(list),
        list,
        id,
        afterSave as AdminDestinationId | undefined,
      ),
  };
};

/** Bind a record read to the session the page route hands it. */
export const loadWithSession =
  <FullRow>(load: LoadCommand<FullRow>) =>
  (id: number, session: AuthSession): Promise<FullRow | null> =>
    load(id, { session });

/** Build the six standard HTML routes for one record. */
export const recordPages = <
  Shape extends RecordShape,
  CreateValues,
  EditValues = CreateValues,
  DeleteInput = undefined,
>(
  record: AdminRecord<Shape>,
  config: RecordPagesConfig<Shape, CreateValues, EditValues, DeleteInput>,
): CrudHandlers => {
  const listRoute = adminDestination(record.list);
  const { createErrorPath, deletePath, editPath, listPath, newPath, savePath } =
    resolvePagePaths(
      listRoute.pattern,
      record.saveLanding ?? (listRoute.afterSave as string | undefined),
      record.list,
      config,
    );
  const auth = recordGates(listPath, newPath, editPath, deletePath);

  const listGet = config.renderList
    ? authPage(auth.list)(async (session) =>
        config.renderList!(
          await record.getAll({ session }),
          session,
          getFlash().success,
        ),
      )
    : notFoundResponse;

  const newGet =
    auth.new === null || config.renderNew === undefined
      ? notFoundResponse
      : authPage(auth.new)((session) =>
          config.renderNew!(session, getFlash().error),
        );

  /** Parse one submitted form, then run the handler or answer its error. */
  const runParsedForm = async (
    form: FormParams,
    edit: boolean,
    onError: ResponseHandler<[message: string]>,
    run: ResponseHandler<[input: InputOf<Shape>]>,
  ): Promise<Response> => {
    const parsed = await parseFormInput(config, form, edit);
    return parsed.ok ? run(parsed.value) : onError(parsed.error);
  };

  const createPost = (request: Request): Promise<Response> =>
    formGuardAt(listPath)(request, (session, form) =>
      runParsedForm(
        form,
        false,
        (message) => errorRedirect(createErrorPath, message),
        async (input) => {
          const verdict = await record.create(input, undefined, { session });
          const refusal = refusalOf(verdict);
          if (refusal !== null) {
            return errorRedirect(createErrorPath, refusal);
          }
          return verdict.kind === "written"
            ? redirect(
                savePath(verdict.row.id),
                `${config.singular} created`,
                true,
              )
            : notFoundResponse();
        },
      ),
    );

  const rejectEdit = (
    id: number,
    session: AuthSession,
    form: FormParams,
    message: string,
  ): Response | Promise<Response> =>
    config.renderEditError
      ? config.renderEditError(id, session, form, message)
      : errorRedirect(
          config.editErrorPath?.(id) ??
            (editPath ?? `${listPath}/:id/edit`).replace(/:[^/]+/, String(id)),
          message,
        );

  const editVerdict = (
    verdict: WriteVerdict<FullRowOf<Shape>>,
    id: number,
    session: AuthSession,
    form: FormParams,
  ): Response | Promise<Response> => {
    if (verdict.kind === "refused") {
      return rejectEdit(id, session, form, verdict.message);
    }
    if (verdict.kind === "not-found") return notFoundResponse();
    return redirect(
      (config.updateSavePath ?? savePath)(verdict.row.id),
      `${config.singular} updated`,
      true,
    );
  };

  const editPost: IdRouteHandler =
    editPath === null || auth.edit === null
      ? () => notFoundResponse()
      : (request, { id }) =>
          auth.edit!(request, (session, form) =>
            runParsedForm(
              form,
              true,
              (message) => rejectEdit(id, session, form, message),
              async (input) =>
                editVerdict(
                  await record.update(id, input, undefined, { session }),
                  id,
                  session,
                  form,
                ),
            ),
          );

  const confirmedDelete = createConfirmedHandlers<
    FullRowOf<Shape>,
    AuthSession
  >({
    auth: { requireSession: auth.delete, withForm: auth.deleteForm },
    ...(config.deleteGuard
      ? {
          guardError: (row: FullRowOf<Shape>, id: number) =>
            config.deleteGuard!(row, id),
        }
      : {}),
    identifier: (row: FullRowOf<Shape>) =>
      config.identifier ? config.identifier(row) : record.nameOf(row),
    identifierLabel: config.identifierLabel ?? "",
    load: loadWithSession(record.load),
    onConfirm: async (_row, id, session, form) => {
      const verdict = await record.remove(
        id,
        config.deleteInput ? config.deleteInput(form) : undefined,
        { session },
      );
      const failure = await deleteFailure(
        verdict,
        deletePath.replace(/:[^/]+/, String(id)),
      );
      return failure ?? undefined;
    },
    path: deletePath,
    render: config.renderDelete ?? (() => ""),
    successMessage: config.deleteSuccessMessage ?? `${config.singular} deleted`,
    successRedirect: config.deleteSuccessPath ?? listPath,
  });

  return {
    createPost,
    deleteGet: idRouteFor(confirmedDelete.get),
    deletePost: idRouteFor(confirmedDelete.post),
    editPost,
    listGet,
    newGet,
    ...config.overrides,
  };
};

/** Build the standard six pages from the parts every table-like record
 *  supplies: its form, its renderers, its noun, and its input mapper. */
export const standardRecordPages = <Shape extends RecordShape, CreateValues>(
  record: AdminRecord<Shape>,
  form: FormSchema<CreateValues>,
  identifierLabel: string,
  renderDelete: RenderDelete<Shape>,
  renderEditError: EditErrorRenderer,
  renderList: RenderList<Shape>,
  renderNew: (session: AdminSession, error?: string) => string,
  singular: string,
  toInput: (
    values: CreateValues,
    form: FormParams,
  ) => InputOf<Shape> | Promise<InputOf<Shape>>,
  validateValues?: (values: CreateValues) => string | null,
): CrudHandlers =>
  recordPages<Shape, CreateValues, CreateValues, never>(record, {
    form,
    identifierLabel,
    renderDelete,
    renderEditError,
    renderList,
    renderNew,
    singular,
    toInput,
    ...(validateValues === undefined ? {} : { validateValues }),
  });
