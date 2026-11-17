import { execute } from "#db/client.ts";
import type { TableHandle, TableWithId } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { type Changes, type ColumnName, rowsWith, update } from "#db/write.ts";

/** Input shared by ordered tables whose only required value is a name. */
export interface NamedSortOrderInput {
  name: string;
  sortOrder?: number;
}

/** Stored values of the trigger-maintained aggregate columns `F`, keyed by column. */
export type AggregateValues<F extends string> = Record<F, number>;

/** Per-column comparison of each aggregate `F`'s stored value against its
 * rebuilt-from-source value — what the "recalculate aggregates" tools return. */
export type AggregateRecalculation<F extends string> = Record<
  F,
  { current: number; recalculated: number }
>;

/** The two owner-facing repairs every trigger-maintained aggregate column set
 * needs: write the numbers the operator typed, and rebuild chosen columns from
 * the rows they count. */
export type AggregateRepairs<F extends string> = {
  reset: (entityId: number, fields: readonly F[]) => Promise<void>;
  update: (entityId: number, values: AggregateValues<F>) => Promise<void>;
};

/**
 * Both repairs for one table's aggregate columns, given the expression that
 * recounts each one for the row `<table>.id`. Every family declares its table
 * and per-column recount here rather than writing the same two wrappers again.
 */
export const aggregateRepairs = <
  Name extends TableWithId,
  F extends ColumnName<Name>,
>(
  table: TableHandle<Name>,
  recount: Record<F, SqlStatement>,
): AggregateRepairs<F> => {
  // TypeScript cannot match the fields of a type parameter to the mapped
  // `Changes` type, or see `id` among them. `TableWithId` and
  // `F extends ColumnName<Name>` hold both.
  const write = async (
    entityId: number,
    changes: Readonly<Record<string, number | SqlStatement>>,
  ): Promise<void> => {
    await execute(
      update(table, changes as Changes<Name>).where(
        rowsWith(table, "id" as ColumnName<Name>, entityId),
      ),
    );
  };
  return {
    reset: async (entityId, fields) => {
      if (fields.length === 0) return;
      await write(
        entityId,
        Object.fromEntries(fields.map((field) => [field, recount[field]])),
      );
    },
    update: (entityId, values) => write(entityId, values),
  };
};
