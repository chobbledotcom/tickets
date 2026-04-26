/**
 * Type-safe table abstraction for database operations
 *
 * Provides a declarative way to define tables with:
 * - Column mappings (camelCase input → snake_case DB)
 * - Generated columns (id, created)
 * - Field transformers (encrypt/decrypt)
 * - Generic CRUD operations
 */

import type { InValue } from "@libsql/client";
import { compact, filter, mapParallel, reduce } from "#fp";
import { getDb, queryAll, queryOne } from "#lib/db/client.ts";

/**
 * Column definition for a table
 */
export type ColumnDef<T = unknown> = {
  /** Whether this column is auto-generated (like id) */
  generated?: boolean;
  /** Default value generator (for created timestamps etc) */
  default?: () => T;
  /** Transform value before writing to DB (e.g., encrypt) */
  write?: (v: T) => Promise<T> | T;
  /** Transform value after reading from DB (e.g., decrypt) */
  read?: (v: T) => Promise<T> | T;
};

/**
 * Table schema definition
 * Keys are DB column names (snake_case), values are column definitions
 */
export type TableSchema<Row> = {
  [K in keyof Row]: ColumnDef<Row[K]>;
};

/** Derive column metadata: whether it's an input column and whether it has a default */
type ColumnMeta<K, Row, Schema extends TableSchema<Row>> = K extends keyof Row
  ? {
      isInput: Schema[K]["generated"] extends true ? false : true;
      hasDefault: Schema[K]["default"] extends () => Row[K] ? true : false;
    }
  : { isInput: false; hasDefault: false };

/** Check if column is input-eligible (not generated) */
type IsInputColumn<K, Row, Schema extends TableSchema<Row>> = ColumnMeta<
  K,
  Row,
  Schema
>["isInput"];

/** Check if column has a default value */
type ColumnHasDefault<K, Row, Schema extends TableSchema<Row>> = ColumnMeta<
  K,
  Row,
  Schema
>["hasDefault"];

/** Extract input keys based on whether they have defaults */
type InputKeysWith<
  Row,
  Schema extends TableSchema<Row>,
  WithDefault extends boolean,
> = {
  [K in keyof Row]: IsInputColumn<K, Row, Schema> extends true
    ? ColumnHasDefault<K, Row, Schema> extends WithDefault
      ? K
      : never
    : never;
}[keyof Row];

/** Required input keys (non-generated, no default) */
type RequiredInputKeys<Row, Schema extends TableSchema<Row>> = InputKeysWith<
  Row,
  Schema,
  false
>;

/** Optional input keys (has default) */
type OptionalInputKeys<Row, Schema extends TableSchema<Row>> = InputKeysWith<
  Row,
  Schema,
  true
>;

/**
 * Derive Input type from Row type and Schema
 * - Excludes generated columns
 * - Makes columns with defaults optional
 */
export type InputFor<Row, Schema extends TableSchema<Row>> = {
  [K in RequiredInputKeys<Row, Schema>]: Row[K];
} & {
  [K in OptionalInputKeys<Row, Schema>]?: Row[K];
};

/**
 * Convert snake_case to camelCase
 */
export const toCamelCase = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Convert camelCase to snake_case
 */
export const toSnakeCase = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Build input key mapping from DB columns
 * snake_case DB column → camelCase input key
 */
export const buildInputKeyMap = (columns: string[]): Record<string, string> =>
  reduce((acc: Record<string, string>, col: string) => {
    acc[col] = toCamelCase(col);
    return acc;
  }, {})(columns);

/**
 * Table definition with CRUD operations
 */
export interface Table<Row, Input> {
  /** Delete a row by primary key */
  deleteById: (id: InValue) => Promise<void>;

  /** Find all rows */
  findAll: () => Promise<Row[]>;

  /** Find a row by primary key */
  findById: (id: InValue) => Promise<Row | null>;

  /** Transform a row from DB (apply read transforms) */
  fromDb: (row: Row) => Promise<Row>;
  inputKeyMap: Record<string, string>;

  /** Insert a new row, returns the created row */
  insert: (input: Input) => Promise<Row>;
  name: string;
  primaryKey: keyof Row & string;

  /**
   * Build an Input object from an existing Row by copying the input-eligible
   * columns and translating keys through `inputKeyMap`. Lets callers spread
   * a row into a new insert without restating every field. Columns named in
   * `exclude` are skipped — useful for auto-stamped fields like `created`.
   */
  rowToInput: (row: Row, exclude?: readonly string[]) => Partial<Input>;
  schema: TableSchema<Row>;

  /** Transform input to DB values (apply write transforms and defaults) */
  toDbValues: (
    input: Input | Partial<Input>,
  ) => Promise<Record<string, InValue>>;

  /** Update a row by primary key, returns updated row or null if not found */
  update: (id: InValue, input: Partial<Input>) => Promise<Row | null>;
}

/** Get value for a column with default applied */
const getValueWithDefault = <T>(value: unknown, def: ColumnDef<T>): unknown => {
  if (value === undefined && def.default) {
    return def.default();
  }
  return value;
};

/** Apply write transform to a value */
const applyWriteTransform = <T>(
  value: unknown,
  def: ColumnDef<T>,
): Promise<unknown> => {
  if (def.write && value !== null && value !== undefined) {
    return Promise.resolve(def.write(value as T));
  }
  return Promise.resolve(value);
};

/** Build INSERT SQL */
const buildInsertSql = (name: string, columns: string[]): string => {
  const placeholders = columns.map(() => "?").join(", ");
  return `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${placeholders})`;
};

/** Build UPDATE SQL with RETURNING to get updated row in one round trip */
const buildUpdateSql = (
  name: string,
  columns: string[],
  primaryKey: string,
): string => {
  const setClauses = columns.map((col) => `${col} = ?`).join(", ");
  return `UPDATE ${name} SET ${setClauses} WHERE ${primaryKey} = ? RETURNING *`;
};

/**
 * Define a table with CRUD operations
 */
export const defineTable = <Row, Input = Row>(config: {
  name: string;
  primaryKey: keyof Row & string;
  schema: TableSchema<Row>;
}): Table<Row, Input> => {
  const { name, primaryKey, schema } = config;

  // Build column lists
  const allColumns = Object.keys(schema) as (keyof Row & string)[];
  const inputColumns = allColumns.filter((col) => !schema[col].generated);
  const inputKeyMap = buildInputKeyMap(inputColumns);

  // Get input value for a column (inputKeyMap always has entry for inputColumns)
  const getInputValue = (
    input: Input | Partial<Input>,
    dbCol: string,
  ): unknown =>
    (input as Record<string, unknown>)[inputKeyMap[dbCol] as string];

  // Transform a row from DB (apply read transforms)
  const fromDb = async (row: Row): Promise<Row> => {
    const entries = await mapParallel(async (col: keyof Row & string) => {
      const def = schema[col];
      const value = row[col];
      if (def.read && value !== null) {
        return [col, await def.read(value as never)] as const;
      }
      return [col, value] as const;
    })(allColumns);
    return Object.fromEntries(entries) as Row;
  };

  // Process a single column for toDbValues
  const processColumn = async (
    col: string,
    input: Input | Partial<Input>,
  ): Promise<[string, InValue] | null> => {
    const def = schema[col as keyof Row];
    const rawValue = getInputValue(input, col);
    const value = getValueWithDefault(rawValue, def);

    if (value === undefined) return null;

    const transformedValue = await applyWriteTransform(value, def);
    return [col, transformedValue as InValue];
  };

  // Transform input to DB values
  const toDbValues = async (
    input: Input | Partial<Input>,
  ): Promise<Record<string, InValue>> => {
    const entries = await mapParallel((col: string) =>
      processColumn(col, input),
    )(inputColumns);
    return Object.fromEntries(compact(entries));
  };

  // Build return row value for a single column
  const getReturnValue = (
    col: string,
    input: Input,
    dbValues: Record<string, InValue>,
  ): unknown => {
    const inputValue = (input as Record<string, unknown>)[
      inputKeyMap[col] as string
    ];
    if (inputValue !== undefined) return inputValue;
    if (col in dbValues) return dbValues[col];
    return null;
  };

  // Insert implementation
  const insert = async (input: Input): Promise<Row> => {
    const dbValues = await toDbValues(input);
    const columns = Object.keys(dbValues);
    // Safe: columns are Object.keys(dbValues), so all values exist
    const args: InValue[] = columns.map((col) => dbValues[col] as InValue);

    const result = await getDb().execute({
      args,
      sql: buildInsertSql(name, columns),
    });

    const initialRow = schema[primaryKey].generated
      ? { [primaryKey]: Number(result.lastInsertRowid) }
      : {};

    return reduce((row: Record<string, unknown>, col: string) => {
      row[col] = getReturnValue(col, input, dbValues);
      return row;
    }, initialRow)(inputColumns) as Row;
  };

  // Get columns that were provided in input
  const getProvidedColumns = (input: Partial<Input>): string[] =>
    filter((col: string) => (inputKeyMap[col] as string) in (input as object))(
      inputColumns,
    );

  // Update implementation - uses RETURNING * to avoid a second round trip
  const update = async (
    id: InValue,
    input: Partial<Input>,
  ): Promise<Row | null> => {
    const dbValues = await toDbValues(input);
    const providedColumns = getProvidedColumns(input);

    if (providedColumns.length === 0) {
      return findById(id);
    }

    // Safe: providedColumns only includes columns from toDbValues result
    const args: InValue[] = [
      ...providedColumns.map((col) => dbValues[col] as InValue),
      id,
    ];

    const row = await queryOne<Row>(
      buildUpdateSql(name, providedColumns, primaryKey),
      args,
    );

    return row ? fromDb(row) : null;
  };

  // Find by ID implementation
  const findById = async (id: InValue): Promise<Row | null> => {
    const row = await queryOne<Row>(
      `SELECT * FROM ${name} WHERE ${primaryKey} = ?`,
      [id],
    );
    return row ? fromDb(row) : null;
  };

  // Delete by ID implementation
  const deleteById = async (id: InValue): Promise<void> => {
    await getDb().execute({
      args: [id],
      sql: `DELETE FROM ${name} WHERE ${primaryKey} = ?`,
    });
  };

  // Find all implementation
  const findAll = async (): Promise<Row[]> => {
    const rows = await queryAll<Row>(`SELECT * FROM ${name}`);
    return mapParallel(fromDb)(rows);
  };

  // Row → Input: copy input-eligible columns from a row, translating
  // snake_case DB column names to camelCase input keys via inputKeyMap.
  // `exclude` lets callers drop columns that shouldn't carry forward
  // (e.g. auto-stamped `created` timestamps when duplicating a row).
  const rowToInput = (
    row: Row,
    exclude: readonly string[] = [],
  ): Partial<Input> => {
    const skip = new Set(exclude);
    return reduce((acc: Record<string, unknown>, col: string) => {
      if (skip.has(col)) return acc;
      const value = (row as Record<string, unknown>)[col];
      if (value !== undefined) {
        acc[inputKeyMap[col] as string] = value;
      }
      return acc;
    }, {})(inputColumns) as Partial<Input>;
  };

  return {
    deleteById,
    findAll,
    findById,
    fromDb,
    inputKeyMap,
    insert,
    name,
    primaryKey,
    rowToInput,
    schema,
    toDbValues,
    update,
  };
};

/**
 * Wrap a table so that insert, update, and deleteById automatically
 * call an invalidation callback (e.g. cache invalidation).
 * Eliminates the repeated spread-and-override pattern in groups/holidays/events.
 */
export const withCacheInvalidation = <Row, Input>(
  table: Table<Row, Input>,
  invalidate: () => void,
): Table<Row, Input> => ({
  ...table,
  deleteById: async (id) => {
    await table.deleteById(id);
    invalidate();
  },
  insert: async (input) => {
    const result = await table.insert(input);
    invalidate();
    return result;
  },
  update: async (id, input) => {
    const result = await table.update(id, input);
    invalidate();
    return result;
  },
});

/** Transform function type for column read/write */
type ColumnTransform<T> = (v: T) => Promise<T> | T;

/** Wrap encrypt/decrypt functions to handle null values */
const wrapNullable =
  <T>(fn: ColumnTransform<T>): ((v: T | null) => Promise<T | null>) =>
  (v) =>
    v === null ? Promise.resolve(null) : Promise.resolve(fn(v));

/**
 * Helper to create column definitions
 */
export const col = {
  /** Boolean column stored as INTEGER 0/1 in the database */
  boolean: (defaultValue: boolean): ColumnDef<boolean> =>
    col.converted<boolean>({
      default: () => defaultValue,
      read: (raw: InValue) => Number(raw) === 1,
      write: (v: boolean) => (v ? 1 : 0),
    }),

  /** Column with type conversion between app and DB representations */
  converted: <App>(config: {
    default?: () => App;
    write: (v: App) => InValue;
    read: (raw: InValue) => App;
  }): ColumnDef<App> => ({
    default: config.default,
    read: config.read as (v: App) => App,
    write: config.write as (v: App) => App,
  }),

  /** Column with read/write transforms (e.g., for encryption) */
  encrypted: <T>(
    encrypt: ColumnTransform<T>,
    decrypt: ColumnTransform<T>,
  ): ColumnDef<T> => ({ read: decrypt, write: encrypt }),

  /** Wrap an existing encrypted column def to pass through null values */
  encryptedNullable: <T>(def: ColumnDef<T>): ColumnDef<T | null> => ({
    read: def.read ? wrapNullable(def.read) : undefined,
    write: def.write ? wrapNullable(def.write) : undefined,
  }),

  /** Encrypted text column with empty-string default */
  encryptedText: (
    encrypt: ColumnTransform<string>,
    decrypt: ColumnTransform<string>,
  ): ColumnDef<string> => ({
    default: () => "",
    read: (v: string) => (v === "" ? v : decrypt(v)),
    write: (v: string) => (v === "" ? v : encrypt(v)),
  }),
  /** Auto-generated column (like id) */
  generated: <T>(): ColumnDef<T> => ({ generated: true }),

  /** Simple column with no special handling */
  simple: <T>(): ColumnDef<T> => ({}),

  /** Column with custom transforms */
  transform: <T>(
    write: (v: T) => Promise<T> | T,
    read: (v: T) => Promise<T> | T,
  ): ColumnDef<T> => ({ read, write }),

  /** Column with default value */
  withDefault: <T>(defaultFn: () => T): ColumnDef<T> => ({
    default: defaultFn,
  }),
};
