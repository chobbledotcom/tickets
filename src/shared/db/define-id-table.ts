import { defineTable, type Table, type TableSchema } from "#shared/db/table.ts";

/**
 * Helper for tables whose primary key column is `id`.
 */
export const defineIdTable = <Row, Input = Row>(
  name: string,
  schema: TableSchema<Row>,
): Table<Row, Input> =>
  defineTable<Row, Input>({
    name,
    primaryKey: "id" as keyof Row & string,
    schema,
  });
