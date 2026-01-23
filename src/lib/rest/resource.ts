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

/**
 * Resource interface - provides typed REST operations
 */
export interface Resource<Row, Input> {
  readonly table: Table<Row, Input>;
  readonly fields: Field[];
  parseInput: (form: URLSearchParams) => ParseResult<Input>;
  parsePartialInput: (form: URLSearchParams) => ParseResult<Partial<Input>>;
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
  toInput: (values: FieldValues) => Input;
  nameField?: keyof Row & string;
  /** Custom delete function (e.g., to delete related records first) */
  onDelete?: (id: InValue) => Promise<void>;
}

/** Validate form and convert to result type */
const validateAndParse = <T>(
  form: URLSearchParams,
  fields: Field[],
  toInput: (values: FieldValues) => T,
): ParseResult<T> => {
  const validation = validateForm(form, fields);
  return validation.valid
    ? { ok: true, input: toInput(validation.values) }
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

/**
 * Define a REST resource with typed CRUD operations.
 */
export const defineResource = <Row, Input>(
  config: ResourceConfig<Row, Input>,
): Resource<Row, Input> => {
  const { table, fields, toInput, nameField } = config;

  const parseInput = (form: URLSearchParams): ParseResult<Input> =>
    validateAndParse(form, fields, toInput);

  const parsePartialInput = (
    form: URLSearchParams,
  ): ParseResult<Partial<Input>> =>
    validateAndParse(
      form,
      fields.filter((f) => form.has(f.name)),
      (v) => toInput(v) as Partial<Input>,
    );

  const create = async (form: URLSearchParams): Promise<CreateResult<Row>> => {
    const parsed = parseInput(form);
    if (!parsed.ok) return parsed;
    return { ok: true, row: await table.insert(parsed.input) };
  };

  const update = async (
    id: InValue,
    form: URLSearchParams,
  ): Promise<UpdateResult<Row>> => {
    const notFound = await requireExists(table, id);
    if (notFound) return notFound;

    const parsed = parseInput(form);
    if (!parsed.ok) return parsed;

    const row = await table.update(id, parsed.input);
    return row ? { ok: true, row } : { ok: false, notFound: true };
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
        const name = String(row[nameField] ?? "");
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
