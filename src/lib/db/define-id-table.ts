import { defineTable, type TableSchema } from "#lib/db/table.ts";

/**
 * Helper for tables whose primary key column is `id`.
 */
export const defineIdTable = <Row, Input = Row>(
  name: string,
  schema: TableSchema<Row>,
) =>
  defineTable<Row, Input>({
    name,
    primaryKey: "id" as keyof Row & string,
    schema,
  });
