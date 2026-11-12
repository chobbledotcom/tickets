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
import { adminDestination, adminRecordPath } from "#shared/admin-surface.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import { checkedValues } from "#shared/forms/validation.ts";
import type { DeleteVerdict, WriteVerdict } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { AdminSession } from "#types";

/** The commands and reads the page door needs from a record. A record with
 * transactional state is still assignable: the extra plan argument is
 * optional. */
export type PageRecord<
  Row extends { id: number },
  Input,
  FullRow extends Row,
  ListRow = FullRow,
> = {
  create: (input: Input) => Promise<WriteVerdict<FullRow>>;
  update: (id: number, input: Input) => Promise<WriteVerdict<FullRow>>;
  remove: (id: number, input?: unknown) => Promise<DeleteVerdict>;
  load: (id: number) => Promise<FullRow | null>;
  getAll: () => Promise<ListRow[]>;
  nameOf: (row: Row) => string;
  list: AdminDestinationId;
  saveLanding?: AdminDestinationId;
};

/** The form facts a page config carries, split out so the parser does not
 *  depend on the renderers. */
type FormInputConfig<CreateValues, EditValues, Input> = {
  form: FormSchema<CreateValues>;
  /** The edit form, when an edit carries fields a create does not. */
  editForm?: FormSchema<EditValues>;
  /** Convert the validated form values into the record's input. `form` rides
   * along for a field the static schema cannot declare, such as a per-member
   * package price keyed by listing id. */
  toInput: (values: CreateValues, form: FormParams) => Input | Promise<Input>;
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
};

/** The page-door facts a record supplies: its renderers, its form, and its
 * confirmation words. `CreateValues` and `EditValues` are separate because an
 * edit form carries a field a create form does not (the group slug). */
export type RecordPagesConfig<
  FullRow,
  Input,
  CreateValues,
  EditValues = CreateValues,
  DeleteInput = undefined,
  ListRow = FullRow,
> = FormInputConfig<CreateValues, EditValues, Input> & {
  renderDelete: (row: FullRow, session: AdminSession, error?: string) => string;
  renderList: (
    rows: ListRow[],
    session: AdminSession,
    successMessage?: string,
  ) => string | Promise<string>;
  renderNew?: (session: AdminSession, error?: string) => string;
  /** The noun the flash messages use ("Holiday created"). */
  singular: string;
  /** Mutate the form before validation (demo overrides). */
  preprocessForm?: (form: FormParams) => void;
  /** Render a rejected edit in place. Keep the submitted values. */
  renderEditError?: EditErrorRenderer;
  identifierLabel: string | (() => string);
  /** The display name the confirmation must match. Defaults to the record's
   * display name. A page whose input cannot carry newlines uses the flattened
   * form, which is what the operator can type. */
  identifier?: (row: FullRow) => string;
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
  deleteGuard?: (row: FullRow, id: number) => Promise<string | null>;
  /** The choice the delete command reads from the submitted form. */
  deleteInput?: (form: FormParams) => DeleteInput;
};

/** The gates the six standard routes run, each from the route it guards. */
type RecordGates = {
  create: FormGuard<AuthSession>;
  delete: SessionGuard<AuthSession>;
  deleteForm: FormGuard<AuthSession>;
  edit: FormGuard<AuthSession>;
  list: SessionGuard<AuthSession>;
  new: SessionGuard<AuthSession> | null;
};

const recordGates = (listPath: string, hasNewPage: boolean): RecordGates => {
  const deletePath = `${listPath}/:id/delete`;
  return {
    create: formGuardAt(listPath),
    delete: pageGuardAt(deletePath),
    deleteForm: formGuardAt(deletePath),
    edit: formGuardAt(`${listPath}/:id/edit`),
    list: pageGuardAt(listPath),
    new: hasNewPage ? pageGuardAt(`${listPath}/new`) : null,
  };
};

/** Run the form's own checks, then convert the values to the record's input.
 * The record's one rule runs inside the record's write command. */
const parseFormInput = async <CreateValues, EditValues, Input>(
  config: FormInputConfig<CreateValues, EditValues, Input>,
  form: FormParams,
  edit: boolean,
): Promise<Result<Input>> => {
  const formError = config.validateForm?.(form);
  if (formError) return errorResult(formError);
  if (edit && config.editForm !== undefined) {
    const parsed = checkedValues(
      config.editForm.validate(form),
      config.validateValues,
    );
    if (!parsed.ok) return parsed;
    const convert = config.toEditInput;
    return okResult(
      convert
        ? await convert(parsed.value, form)
        : await config.toInput(parsed.value as never, form),
    );
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

/**
 * Build the six standard HTML routes for one record.
 */
export const recordPages = <
  Row extends { id: number },
  Input,
  FullRow extends Row,
  CreateValues,
  EditValues = CreateValues,
  DeleteInput = undefined,
  ListRow = FullRow,
>(
  record: PageRecord<Row, Input, FullRow, ListRow>,
  config: RecordPagesConfig<
    FullRow,
    Input,
    CreateValues,
    EditValues,
    DeleteInput,
    ListRow
  >,
): CrudHandlers => {
  const listRoute = adminDestination(record.list);
  const listPath = listRoute.pattern;
  const saveRouteId =
    record.saveLanding ??
    (listRoute.afterSave as AdminDestinationId | undefined) ??
    record.list;
  const savePath = (id: number): string => {
    if (config.savePath) return config.savePath(id);
    const route = adminDestination(saveRouteId);
    return route.pattern.includes(":")
      ? adminRecordPath(saveRouteId, id)
      : route.pattern;
  };
  const deletePath = `${listPath}/:id/delete`;
  const auth = recordGates(listPath, config.renderNew !== undefined);
  const createErrorPath = config.createErrorPath ?? `${listPath}/new`;

  const readInput = async (
    form: FormParams,
    edit: boolean,
  ): Promise<Result<Input>> => {
    config.preprocessForm?.(form);
    return parseFormInput(config, form, edit);
  };

  const listGet = authPage(auth.list)(async (session) =>
    config.renderList(await record.getAll(), session, getFlash().success),
  );

  const newGet =
    auth.new === null || config.renderNew === undefined
      ? notFoundResponse
      : authPage(auth.new)((session) =>
          config.renderNew!(session, getFlash().error),
        );

  const createPost = (request: Request): Promise<Response> =>
    formGuardAt(listPath)(request, async (_session, form) => {
      const parsed = await readInput(form, false);
      if (!parsed.ok) return errorRedirect(createErrorPath, parsed.error);
      const verdict = await record.create(parsed.value);
      const refusal = refusalOf(verdict);
      if (refusal !== null) return errorRedirect(createErrorPath, refusal);
      return verdict.kind === "written"
        ? redirect(savePath(verdict.row.id), `${config.singular} created`, true)
        : notFoundResponse();
    });

  const editPost: IdRouteHandler = (request, { id }) =>
    formGuardAt(`${listPath}/:id/edit`)(request, async (session, form) => {
      const parsed = await readInput(form, true);
      const reject = (message: string): Response | Promise<Response> =>
        config.renderEditError
          ? config.renderEditError(id, session, form, message)
          : errorRedirect(
              config.editErrorPath?.(id) ?? `${listPath}/${id}/edit`,
              message,
            );
      if (!parsed.ok) return reject(parsed.error);
      const verdict = await record.update(id, parsed.value);
      const refusal = refusalOf(verdict);
      if (refusal !== null) return reject(refusal);
      return verdict.kind === "written"
        ? redirect(
            (config.updateSavePath ?? savePath)(verdict.row.id),
            `${config.singular} updated`,
            true,
          )
        : notFoundResponse();
    });

  const confirmedDelete = createConfirmedHandlers<FullRow, AdminSession>({
    auth: { requireSession: auth.delete, withForm: auth.deleteForm },
    ...(config.deleteGuard
      ? {
          guardError: (row: FullRow, id: number) =>
            config.deleteGuard!(row, id),
        }
      : {}),
    identifier: (row: FullRow) =>
      config.identifier ? config.identifier(row) : record.nameOf(row),
    identifierLabel: config.identifierLabel,
    load: (id) => record.load(id),
    onConfirm: async (_row, id, _session, form) => {
      const verdict = await record.remove(
        id,
        config.deleteInput ? config.deleteInput(form) : undefined,
      );
      const failure = await deleteFailure(verdict, `${listPath}/${id}/delete`);
      return failure ?? undefined;
    },
    path: deletePath,
    render: config.renderDelete,
    successMessage: `${config.singular} deleted`,
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
