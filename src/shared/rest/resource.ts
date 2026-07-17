/**
 * REST resource abstraction - ties together table definitions, form fields,
 * and HTTP handlers for unified CRUD operations.
 *
 * Usage:
 *   const listingsResource = defineResource({
 *     table: listingsTable,
 *     form: listingForm,
 *     toInput: extractListingInput,
 *     nameField: 'name', // For delete verification
 *   });
 *
 *   // Create from form data
 *   const result = await listingsResource.create(form);
 *   if (!result.ok) return errorResponse(result.error);
 *   return redirect('/admin/');
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import type { TxScope } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";
import type { FieldValues } from "#shared/forms/values.ts";
import { mapValidationError } from "#shared/optional-validate.ts";
import type { AfterCommitConfig, ParseResult } from "#shared/rest/crud-api.ts";
import { writeEntity } from "#shared/rest/write-entity.ts";

/* jscpd:ignore-end */

/** Success result with data */
type SuccessResult<T> = { ok: true } & T;

/** Error result with message */
type ErrorResult = { ok: false; error: string };

/** Not found result */
type NotFoundResult = { ok: false; notFound: true; error?: never };

/** Result type for create operations */
export type CreateResult<Row> = SuccessResult<{ row: Row }> | ErrorResult;

/** Result type for update operations */
export type UpdateResult<Row> =
  | SuccessResult<{ row: Row }>
  | ErrorResult
  | NotFoundResult;

/** Result type for delete operations */
export type DeleteResult = SuccessResult<object> | ErrorResult | NotFoundResult;

/** Validation function type — Id defaults to InValue for broad compatibility */
type ValidateFn<Input, Id = InValue> =
  | ((input: Input, id?: Id) => Promise<string | null>)
  | undefined;

/**
 * Resource interface - provides typed REST operations
 */
export interface Resource<
  Row,
  Input,
  _Values extends FieldValues = FieldValues,
> {
  create: (form: FormParams) => Promise<CreateResult<Row>>;
  delete: (id: InValue) => Promise<DeleteResult>;
  readonly fields: readonly Field[];
  parseInput: (form: FormParams) => Promise<ParseResult<Input>>;
  readonly table: Table<Row, Input>;
  update: (id: InValue, form: FormParams) => Promise<UpdateResult<Row>>;
  verifyName?: (row: Row, confirmName: string) => boolean;
}

/**
 * Configuration for defineResource
 */
export interface ResourceConfig<
  Row,
  Input,
  Id = InValue,
  Values extends FieldValues = FieldValues,
> extends AfterCommitConfig {
  /** Side-effect run after a successful create/update with the written row's
   * id, the parsed input, and the raw form — e.g. to persist join-table rows (a
   * listing's groups) or dynamic inputs (a group's per-listing package prices)
   * that live outside the main table. Runs inside the SAME transaction as the
   * row write (it receives the transaction scope), so a failure rolls the row
   * write back rather than leaving partial state. */
  afterWrite?: (
    tx: TxScope,
    id: number,
    input: Input,
    form: FormParams,
  ) => Promise<void>;
  form: FormSchema<Values>;
  nameField?: keyof Row & string;
  /** Custom delete function (e.g., to delete related records first) */
  onDelete?: (id: InValue) => Promise<void>;
  table: Table<Row, Input>;
  toInput: (values: Values) => Input | Promise<Input>;
  /** Custom validation (e.g., check uniqueness). Return error message or null. */
  validate?: ValidateFn<Input, Id>;
  /** Cross-field validation on the parsed form values, before `toInput`. Unlike
   * `validate` (which runs on the converted `Input`), this sees the raw field
   * values together, so a field whose rule depends on a sibling — e.g. a
   * modifier's `calc_value` bounds depend on its `calc_kind` — can be checked
   * where both are visible. Return an error message or null. */
  validateValues?: (values: Values) => string | null;
}

/** Validate form and convert to result type */
const validateAndParse = async <T, V extends FieldValues = FieldValues>(
  form: FormParams,
  schema: FormSchema<V>,
  toInput: (values: V) => T | Promise<T>,
  validateValues?: (values: V) => string | null,
): Promise<ParseResult<T>> => {
  const validation = schema.validate(form);
  if (!validation.valid) return { error: validation.error, ok: false };
  const valuesError = validateValues?.(validation.values);
  if (valuesError) return { error: valuesError, ok: false };
  return { input: await toInput(validation.values), ok: true };
};

/** Run async validation, return error result or null */
const runValidation = <Input, Id>(
  validate: ValidateFn<Input, Id>,
  input: Input,
  id?: Id,
): Promise<ErrorResult | null> =>
  mapValidationError(
    validate && (() => validate(input, id)),
    (error): ErrorResult => ({ error, ok: false }),
  );

/** Convert row or null to update result */
const toUpdateResult = <Row>(row: Row | null): UpdateResult<Row> =>
  row ? { ok: true, row } : { notFound: true, ok: false };

/** Parse and validate input, returning parsed input or error */
const parseAndValidate = async <Input, Id>(
  form: FormParams,
  parseInput: (form: FormParams) => Promise<ParseResult<Input>>,
  validate: ValidateFn<Input, Id>,
  id?: Id,
): Promise<ParseResult<Input>> => {
  const parsed = await parseInput(form);
  if (!parsed.ok) return parsed;
  const validationError = await runValidation(validate, parsed.input, id);
  return validationError ?? parsed;
};

/** Resource with required name verification (created when nameField is provided) */
export type NamedResource<
  Row,
  Input,
  Values extends FieldValues = FieldValues,
> = Resource<Row, Input, Values> & {
  verifyName: (row: Row, confirmName: string) => boolean;
};

/**
 * Define a REST resource with typed CRUD operations.
 */
export const defineResource = <
  Row extends { id: number },
  Input,
  Id = InValue,
  Values extends FieldValues = FieldValues,
>(
  config: ResourceConfig<Row, Input, Id, Values>,
): Resource<Row, Input, Values> => {
  const { table, form: schema, toInput, nameField } = config;

  const parseInput = (form: FormParams): Promise<ParseResult<Input>> =>
    validateAndParse<Input, Values>(
      form,
      schema,
      toInput,
      config.validateValues,
    );

  /** Run `fn` only when the row exists; otherwise report not found. */
  const withExistingRow = async <Outcome>(
    id: InValue,
    fn: () => Promise<Outcome>,
  ): Promise<Outcome | NotFoundResult> =>
    (await table.findById(id)) ? fn() : { notFound: true, ok: false };

  /** Parse + validate the form, write the row (transactionally when
   * `afterWrite` is set, else the plain insert/update `fallback`), then run the
   * post-commit hook. `existingId` is null on create and the row id on update.
   * Returns the parse/validate error, or the written row. */
  const parseWriteAndCommit = async (
    form: FormParams,
    existingId: number | null,
    fallback: (input: Input) => Promise<Row | null>,
    id?: Id,
  ): Promise<ErrorResult | { ok: true; row: Row | null }> => {
    const result = await parseAndValidate(
      form,
      parseInput,
      config.validate,
      id,
    );
    if (!result.ok) return result;
    const row = await writeEntity<Row>({
      afterCommit: config.afterCommit,
      buildStatement: () =>
        existingId === null
          ? table.insertStatement!(result.input)
          : table.updateStatement!(existingId, result.input),
      existingId,
      joinWrites: config.afterWrite
        ? [(tx, rowId) => config.afterWrite!(tx, rowId, result.input, form)]
        : [],
      plainWrite: () => fallback(result.input),
      readBack: (rowId) => table.findByIdPrimary!(rowId),
    });
    return { ok: true, row };
  };

  const create = async (form: FormParams): Promise<CreateResult<Row>> => {
    const result = await parseWriteAndCommit(form, null, (input) =>
      table.insert(input),
    );
    return result.ok ? { ok: true, row: result.row as Row } : result;
  };

  const update = (id: InValue, form: FormParams): Promise<UpdateResult<Row>> =>
    withExistingRow(id, async (): Promise<UpdateResult<Row>> => {
      const result = await parseWriteAndCommit(
        form,
        id as number,
        (input) => table.update(id, input),
        id as Id,
      );
      return result.ok ? toUpdateResult(result.row) : result;
    });

  const deleteRow = (id: InValue): Promise<DeleteResult> =>
    withExistingRow(id, async (): Promise<DeleteResult> => {
      if (config.onDelete) {
        await config.onDelete(id);
      } else {
        await table.deleteById(id);
      }
      return { ok: true };
    });

  const verifyName = nameField
    ? (row: Row, confirmName: string): boolean => {
        const name = String(row[nameField]);
        return name.trim().toLowerCase() === confirmName.trim().toLowerCase();
      }
    : undefined;

  return {
    create,
    delete: deleteRow,
    fields: schema.fields,
    parseInput,
    table,
    update,
    ...(verifyName && { verifyName }),
  };
};

/**
 * Define a named REST resource - requires nameField and guarantees verifyName is present.
 */
export const defineNamedResource = <
  Row extends { id: number },
  Input,
  Id = InValue,
  V extends FieldValues = FieldValues,
>(
  config: ResourceConfig<Row, Input, Id, V> & {
    nameField: keyof Row & string;
  },
): NamedResource<Row, Input, V> =>
  defineResource(config) as NamedResource<Row, Input, V>;
