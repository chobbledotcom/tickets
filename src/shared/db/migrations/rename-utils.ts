import { countRows, getDb } from "#db/client.ts";
import { sql, sqlName, type SqlStatement } from "#db/sql.ts";
import { escapeRegExp } from "#shared/regexp.ts";
import {
  currentSchemaColumnsPresentIn,
  getExistingColumns,
  rebuildTableWithColumns,
  runMigration,
  tableExists,
} from "./schema-sync.ts";

export type LegacyTableRename = readonly [legacy: string, target: string];
export type LegacyColumnRename = readonly [
  table: string,
  legacy: string,
  target: string,
];

export type LegacyRenamePlan = {
  tableRenames: readonly LegacyTableRename[];
  columnRenames: readonly LegacyColumnRename[];
};

/** One column rename: the table and its legacy → target column names. The
 *  shared shape the column-value counter and the column-rename repair pass on. */
type ColumnRename = { table: string; legacy: string; target: string };

type RenameState = "neither" | "target_only" | "legacy_only" | "both";

const renameState = (
  legacyExists: boolean,
  targetExists: boolean,
): RenameState => {
  if (legacyExists && targetExists) return "both";
  if (legacyExists) return "legacy_only";
  if (targetExists) return "target_only";
  return "neither";
};

const applyDirectRename = async (
  state: RenameState,
  rename: SqlStatement,
): Promise<boolean> => {
  if (state === "neither" || state === "target_only") return true;
  if (state !== "legacy_only") return false;
  await runMigration(rename);
  return true;
};

const tableRenameState = async (
  legacy: string,
  target: string,
): Promise<RenameState> => {
  const [legacyExists, targetExists] = await Promise.all([
    tableExists(legacy),
    tableExists(target),
  ]);
  return renameState(legacyExists, targetExists);
};

const renameTableStatement = (legacy: string, target: string): SqlStatement =>
  sql`ALTER TABLE ${sqlName(legacy)} RENAME TO ${sqlName(target)}`;

const repairLegacyTableRename = async (
  legacy: string,
  target: string,
): Promise<void> => {
  const state = await tableRenameState(legacy, target);
  if (
    await applyDirectRename(state, renameTableStatement(legacy, target))
  ) {
    return;
  }
  // state === "both" — a failed prior migration attempt created the empty
  // target before it renamed the legacy table. Only auto-resolve when the
  // target is provably empty. Otherwise refuse to guess how to merge.
  const targetCount = await countRows(target);
  if (targetCount > 0) {
    throw new Error(
      `Cannot migrate "${legacy}" -> "${target}": both tables exist and the ` +
        `target has ${targetCount} row(s). Manual migration is required — ` +
        "back up the database, merge the legacy rows into the target by hand, " +
        "drop the legacy table, then re-run the migration.",
    );
  }
  await runMigration(sql`DROP TABLE ${sqlName(target)}`);
  await runMigration(renameTableStatement(legacy, target));
};

const columnRenameState = (
  cols: Set<string>,
  legacy: string,
  target: string,
): RenameState => renameState(cols.has(legacy), cols.has(target));

type ColumnValueStats = {
  conflictCount: number;
  legacyCount: number;
  targetCount: number;
};

const countColumnValueStats = async ({
  table,
  legacy,
  target,
}: ColumnRename): Promise<ColumnValueStats> => {
  const result = await getDb().execute(
    sql`SELECT
       COALESCE(SUM(CASE WHEN ${sqlName(legacy)} IS NOT NULL THEN 1 ELSE 0 END), 0) AS legacy_count,
       COALESCE(SUM(CASE WHEN ${sqlName(target)} IS NOT NULL THEN 1 ELSE 0 END), 0) AS target_count,
       COALESCE(SUM(CASE WHEN ${sqlName(legacy)} IS NOT NULL AND ${sqlName(target)} IS NOT NULL AND ${sqlName(legacy)} != ${sqlName(target)} THEN 1 ELSE 0 END), 0) AS conflict_count
     FROM ${sqlName(table)}`,
  );
  const row = result.rows[0]!;
  return {
    conflictCount: Number(row.conflict_count),
    legacyCount: Number(row.legacy_count),
    targetCount: Number(row.target_count),
  };
};

const sqlIdentifierPattern = (name: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`);

const dropProjectIndexesReferencingColumn = async (
  table: string,
  column: string,
): Promise<void> => {
  const { rows } = await getDb().execute(
    sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL`,
  );

  const referencesColumn = sqlIdentifierPattern(column);
  for (const row of rows) {
    const name = String(row.name);
    if (name.startsWith("idx_") && referencesColumn.test(String(row.sql))) {
      await runMigration(sql`DROP INDEX IF EXISTS ${sqlName(name)}`);
    }
  }
};

const columnHasForeignKey = async (
  table: string,
  column: string,
): Promise<boolean> => {
  const result = await getDb().execute(
    sql`PRAGMA foreign_key_list(${sqlName(table)})`,
  );
  return result.rows.some((row) => String(row.from) === column);
};

const repairLegacyColumnRename = async ({
  table,
  legacy,
  target,
}: ColumnRename): Promise<void> => {
  const existingColumns = await getExistingColumns(table);
  if (existingColumns.size === 0) return;

  const state = columnRenameState(existingColumns, legacy, target);
  if (
    await applyDirectRename(
      state,
      sql`ALTER TABLE ${sqlName(table)} RENAME COLUMN ${sqlName(legacy)} TO ${sqlName(target)}`,
    )
  ) {
    return;
  }

  const { conflictCount, legacyCount, targetCount } =
    await countColumnValueStats({ legacy, table, target });
  if (conflictCount > 0) {
    throw new Error(
      `Cannot migrate "${table}.${legacy}" -> "${table}.${target}": both ` +
        `columns contain conflicting data (${legacyCount} legacy row(s), ` +
        `${targetCount} target row(s), ${conflictCount} conflict row(s)). ` +
        "Manual migration is required — " +
        "back up the database, merge the legacy column values into the " +
        "target by hand, drop the legacy column, then re-run the migration.",
    );
  }

  if (legacyCount > 0) {
    await runMigration(
      sql`UPDATE ${sqlName(table)} SET ${sqlName(target)} = ${sqlName(legacy)} WHERE ${sqlName(target)} IS NULL`,
    );
  }
  if (await columnHasForeignKey(table, legacy)) {
    await rebuildTableWithColumns({
      columns: currentSchemaColumnsPresentIn(table, existingColumns),
      tableName: table,
      tmpName: `${table}_rename_rebuild`,
    });
  } else {
    await dropProjectIndexesReferencingColumn(table, legacy);
    await runMigration(
      sql`ALTER TABLE ${sqlName(table)} DROP COLUMN ${sqlName(legacy)}`,
    );
  }
};

/**
 * Repair-safe legacy schema renames. This runs before schema sync so a failed
 * older run that created empty targets can be retried without dropping legacy
 * data.
 */
export const repairLegacyRenames = async (
  plan: LegacyRenamePlan,
): Promise<void> => {
  for (const [legacy, target] of plan.tableRenames) {
    await repairLegacyTableRename(legacy, target);
  }
  for (const [table, legacy, target] of plan.columnRenames) {
    await repairLegacyColumnRename({ legacy, table, target });
  }
};
