/**
 * REST resource abstraction - ties together table definitions, form fields,
 * and HTTP handlers for unified CRUD operations.
 *
 * Usage:
 *   const listingsResource = defineResource({
 *     table: listingsTable,
 *     fields: getListingFields(),
 *     toInput: extractListingInput,
 *     nameField: 'name', // For delete verification
 *   });
 *
 *   // Create from form data
 *   const result = await listingsResource.create(form);
 *   if (!result.ok) return errorResponse(result.error);
 *   return redirect('/admin/');
 */

import type { InValue } from "@libsql/client";
import { type TxScope, writeRowInTransaction } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field, FieldValues } from "#shared/forms.tsx";
import { validateForm } from "#shared/forms.tsx";

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

/** Result type for input parsing */
export type ParseResult<Input> = SuccessResult<{ input: Input }> | ErrorResult;

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
  readonly fields: Field[];
  parseInput: (form: FormParams) => Promise<ParseResult<Input>>;
  parsePartialInput: (form: FormParams) => Promise<ParseResult<Partial<Input>>>;
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
> {
  fields: Field[];
  nameField?: keyof Row & string;
  /** Custom delete function (e.g., to delete related records first) */
  onDelete?: (id: InValue) => Promise<void>;
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
  /** Run after a successful create/update has committed, keyed on the row id.
   * Unlike `afterWrite` (which shares the write transaction), this fires
   * post-commit — for reconciling a derived table (e.g. listing_prices) that the
   * transactional `insertStatement`/`updateStatement` path would otherwise
   * bypass along with the {@link Table} wrapper. */
  afterCommit?: (id: number) => Promise<void>;
  table: Table<Row, Input>;
  toInput: (values: Values) => Input | Promise<Input>;
  /** Custom validation (e.g., check uniqueness). Return error message or null. */
  validate?: ValidateFn<Input, Id>;
}

/** Validate form and convert to result type */
const validateAndParse = async <T, V extends FieldValues = FieldValues>(
  form: FormParams,
  fields: Field[],
  toInput: (values: V) => T | Promise<T>,
): Promise<ParseResult<T>> => {
  const validation = validateForm<V>(form, fields);
  return validation.valid
    ? { input: await toInput(validation.values), ok: true }
    : { error: validation.error, ok: false };
};

/** Check existence and return not found result if missing */
const requireExists = async <Row, Input>(
  table: Table<Row, Input>,
  id: InValue,
): Promise<NotFoundResult | null> => {
  const existing = await table.findById(id);
  return existing ? null : { notFound: true, ok: false };
};

/** Run async validation, return error result or null */
const runValidation = async <Input, Id>(
  validate: ValidateFn<Input, Id>,
  input: Input,
  id?: Id,
): Promise<ErrorResult | null> => {
  if (!validate) return null;
  const error = await validate(input, id);
  return error ? { error, ok: false } : null;
};

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
  Row,
  Input,
  Id = InValue,
  Values extends FieldValues = FieldValues,
>(
  config: ResourceConfig<Row, Input, Id, Values>,
): Resource<Row, Input, Values> => {
  const { table, fields, toInput, nameField } = config;

  const parseInput = (form: FormParams): Promise<ParseResult<Input>> =>
    validateAndParse<Input, Values>(form, fields, toInput);

  const parsePartialInput = (
    form: FormParams,
  ): Promise<ParseResult<Partial<Input>>> =>
    validateAndParse<Partial<Input>, Values>(
      form,
      fields.filter((f) => form.has(f.name)),
      async (v) => (await toInput(v)) as Partial<Input>,
    );

  /** Write the row and its `afterWrite` join writes in ONE transaction, so a
   * failed join write rolls the row write back rather than leaving the row saved
   * without its memberships/overrides. `existingId` is null on create (the id
   * comes from the INSERT) and the existing id on update. Only used when
   * `config.afterWrite` is set; the committed row is read back afterwards. */
  const writeInTransaction = async (
    existingId: number | null,
    input: Input,
    form: FormParams,
  ): Promise<Row | null> => {
    const statement =
      existingId === null
        ? await table.insertStatement!(input)
        : await table.updateStatement!(existingId, input);
    const id = await writeRowInTransaction(statement, existingId, (tx, rowId) =>
      config.afterWrite!(tx, rowId, input, form),
    );
    return table.findById(id);
  };

  const create = async (form: FormParams): Promise<CreateResult<Row>> => {
    const result = await parseAndValidate(form, parseInput, config.validate);
    if (!result.ok) return result;
    const row = config.afterWrite
      ? ((await writeInTransaction(null, result.input, form)) as Row)
      : await table.insert(result.input);
    if (config.afterCommit)
      await config.afterCommit((row as unknown as { id: number }).id);
    return { ok: true, row };
  };

  const update = async (
    id: InValue,
    form: FormParams,
  ): Promise<UpdateResult<Row>> => {
    const notFound = await requireExists(table, id);
    if (notFound) return notFound;
    const result = await parseAndValidate(
      form,
      parseInput,
      config.validate,
      id as Id,
    );
    if (!result.ok) return result;
    const row = config.afterWrite
      ? await writeInTransaction(id as number, result.input, form)
      : await table.update(id, result.input);
    if (row && config.afterCommit) {
      await config.afterCommit((row as unknown as { id: number }).id);
    }
    return toUpdateResult(row);
  };

  const deleteRow = async (id: InValue): Promise<DeleteResult> => {
    const notFound = await requireExists(table, id);
    if (notFound) return notFound;

    if (config.onDelete) {
      await config.onDelete(id);
    } else {
      await table.deleteById(id);
    }
    return { ok: true };
  };

  const verifyName = nameField
    ? (row: Row, confirmName: string): boolean => {
        const name = String(row[nameField]);
        return name.trim().toLowerCase() === confirmName.trim().toLowerCase();
      }
    : undefined;

  return {
    create,
    delete: deleteRow,
    fields,
    parseInput,
    parsePartialInput,
    table,
    update,
    ...(verifyName && { verifyName }),
  };
};

/**
 * Define a named REST resource - requires nameField and guarantees verifyName is present.
 */
export const defineNamedResource = <
  Row,
  Input,
  Id = InValue,
  V extends FieldValues = FieldValues,
>(
  config: ResourceConfig<Row, Input, Id, V> & {
    nameField: keyof Row & string;
  },
): NamedResource<Row, Input, V> =>
  defineResource(config) as NamedResource<Row, Input, V>;
