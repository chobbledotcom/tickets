/**
 * REST resource abstraction - ties together table definitions, form fields,
 * and HTTP handlers for unified CRUD operations.
 *
 * Usage:
 *   const eventsResource = defineResource({
 *     table: eventsTable,
 *     fields: eventFields,
 *     toInput: extractEventInput,
 *     nameField: 'name', // For delete verification
 *   });
 *
 *   // Create from form data
 *   const result = await eventsResource.create(form);
 *   if (!result.ok) return errorResponse(result.error);
 *   return redirect('/admin/');
 */

import type { InValue } from "@libsql/client";
import type { Table } from "#lib/db/table.ts";
import type { Field, FieldValues } from "#lib/forms.tsx";
import { validateForm } from "#lib/forms.tsx";

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

/** Validation function type */
type ValidateFn<Input> =
  | ((input: Input, id?: InValue) => Promise<string | null>)
  | undefined;

/**
 * Resource interface - provides typed REST operations
 */
export interface Resource<Row, Input> {
  readonly table: Table<Row, Input>;
  readonly fields: Field[];
  parseInput: (form: URLSearchParams) => Promise<ParseResult<Input>>;
  parsePartialInput: (form: URLSearchParams) => Promise<ParseResult<Partial<Input>>>;
  create: (form: URLSearchParams) => Promise<CreateResult<Row>>;
  update: (id: InValue, form: URLSearchParams) => Promise<UpdateResult<Row>>;
  delete: (id: InValue) => Promise<DeleteResult>;
  verifyName?: (row: Row, confirmName: string) => boolean;
}

/**
 * Configuration for defineResource
 */
export interface ResourceConfig<Row, Input> {
  table: Table<Row, Input>;
  fields: Field[];
  toInput: (values: FieldValues) => Input | Promise<Input>;
  nameField?: keyof Row & string;
  /** Custom delete function (e.g., to delete related records first) */
  onDelete?: (id: InValue) => Promise<void>;
  /** Custom validation (e.g., check uniqueness). Return error message or null. */
  validate?: (input: Input, id?: InValue) => Promise<string | null>;
}

/** Validate form and convert to result type */
const validateAndParse = async <T>(
  form: URLSearchParams,
  fields: Field[],
  toInput: (values: FieldValues) => T | Promise<T>,
): Promise<ParseResult<T>> => {
  const validation = validateForm(form, fields);
  return validation.valid
    ? { ok: true, input: await toInput(validation.values) }
    : { ok: false, error: validation.error };
};

/** Check existence and return not found result if missing */
const requireExists = async <Row, Input>(
  table: Table<Row, Input>,
  id: InValue,
): Promise<NotFoundResult | null> => {
  const existing = await table.findById(id);
  return existing ? null : { ok: false, notFound: true };
};

/** Run async validation, return error result or null */
const runValidation = async <Input>(
  validate: ValidateFn<Input>,
  input: Input,
  id?: InValue,
): Promise<ErrorResult | null> => {
  if (!validate) return null;
  const error = await validate(input, id);
  return error ? { ok: false, error } : null;
};

/** Convert row or null to update result */
const toUpdateResult = <Row>(row: Row | null): UpdateResult<Row> =>
  row ? { ok: true, row } : { ok: false, notFound: true };

/** Parse and validate input, returning parsed input or error */
const parseAndValidate = async <Input>(
  form: URLSearchParams,
  parseInput: (form: URLSearchParams) => Promise<ParseResult<Input>>,
  validate: ValidateFn<Input>,
  id?: InValue,
): Promise<ParseResult<Input>> => {
  const parsed = await parseInput(form);
  if (!parsed.ok) return parsed;
  const validationError = await runValidation(validate, parsed.input, id);
  return validationError ?? parsed;
};

/**
 * Define a REST resource with typed CRUD operations.
 */
export const defineResource = <Row, Input>(
  config: ResourceConfig<Row, Input>,
): Resource<Row, Input> => {
  const { table, fields, toInput, nameField } = config;

  const parseInput = (form: URLSearchParams): Promise<ParseResult<Input>> =>
    validateAndParse(form, fields, toInput);

  const parsePartialInput = (
    form: URLSearchParams,
  ): Promise<ParseResult<Partial<Input>>> =>
    validateAndParse(
      form,
      fields.filter((f) => form.has(f.name)),
      async (v) => (await toInput(v)) as Partial<Input>,
    );

  const create = async (form: URLSearchParams): Promise<CreateResult<Row>> => {
    const result = await parseAndValidate(form, parseInput, config.validate);
    return result.ok
      ? { ok: true, row: await table.insert(result.input) }
      : result;
  };

  const update = async (
    id: InValue,
    form: URLSearchParams,
  ): Promise<UpdateResult<Row>> => {
    const notFound = await requireExists(table, id);
    if (notFound) return notFound;
    const result = await parseAndValidate(
      form,
      parseInput,
      config.validate,
      id,
    );
    return result.ok
      ? toUpdateResult(await table.update(id, result.input))
      : result;
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
    table,
    fields,
    parseInput,
    parsePartialInput,
    create,
    update,
    delete: deleteRow,
    ...(verifyName && { verifyName }),
  };
};
