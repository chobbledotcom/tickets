import { countRows, getDb } from "#shared/db/client.ts";
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
  sql: string,
): Promise<boolean> => {
  if (state === "neither" || state === "target_only") return true;
  if (state !== "legacy_only") return false;
  await runMigration(sql);
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

const repairLegacyTableRename = async (
  legacy: string,
  target: string,
): Promise<void> => {
  const state = await tableRenameState(legacy, target);
  if (
    await applyDirectRename(state, `ALTER TABLE ${legacy} RENAME TO ${target}`)
  ) {
    return;
  }
  // state === "both" — a failed prior migration attempt created the empty
  // target before the legacy table could be renamed. Only auto-resolve when
  // the target is provably empty; otherwise refuse to guess how to merge.
  const targetCount = await countRows(target);
  if (targetCount > 0) {
    throw new Error(
      `Cannot migrate "${legacy}" -> "${target}": both tables exist and the ` +
        `target has ${targetCount} row(s). Manual migration is required — ` +
        "back up the database, merge the legacy rows into the target by hand, " +
        "drop the legacy table, then re-run the migration.",
    );
  }
  await runMigration(`DROP TABLE ${target}`);
  await runMigration(`ALTER TABLE ${legacy} RENAME TO ${target}`);
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

const countColumnValueStats = async (
  table: string,
  legacy: string,
  target: string,
): Promise<ColumnValueStats> => {
  const result = await getDb().execute(
    `SELECT
       COALESCE(SUM(CASE WHEN ${legacy} IS NOT NULL THEN 1 ELSE 0 END), 0) AS legacy_count,
       COALESCE(SUM(CASE WHEN ${target} IS NOT NULL THEN 1 ELSE 0 END), 0) AS target_count,
       COALESCE(SUM(CASE WHEN ${legacy} IS NOT NULL AND ${target} IS NOT NULL AND ${legacy} != ${target} THEN 1 ELSE 0 END), 0) AS conflict_count
     FROM ${table}`,
  );
  const row = result.rows[0]!;
  return {
    conflictCount: Number(row.conflict_count),
    legacyCount: Number(row.legacy_count),
    targetCount: Number(row.target_count),
  };
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sqlIdentifierPattern = (name: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`);

const dropProjectIndexesReferencingColumn = async (
  table: string,
  column: string,
): Promise<void> => {
  const result = await getDb().execute({
    args: [table],
    sql:
      "SELECT name, sql FROM sqlite_master " +
      "WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
  });

  const referencesColumn = sqlIdentifierPattern(column);
  for (const row of result.rows) {
    const name = String(row.name);
    const sql = String(row.sql);
    if (name.startsWith("idx_") && referencesColumn.test(sql)) {
      await runMigration(`DROP INDEX IF EXISTS ${name}`);
    }
  }
};

const columnHasForeignKey = async (
  table: string,
  column: string,
): Promise<boolean> => {
  const result = await getDb().execute(`PRAGMA foreign_key_list(${table})`);
  return result.rows.some((row) => String(row.from) === column);
};

const repairLegacyColumnRename = async (
  table: string,
  legacy: string,
  target: string,
): Promise<void> => {
  const existingColumns = await getExistingColumns(table);
  if (existingColumns.size === 0) return;

  const state = columnRenameState(existingColumns, legacy, target);
  if (
    await applyDirectRename(
      state,
      `ALTER TABLE ${table} RENAME COLUMN ${legacy} TO ${target}`,
    )
  ) {
    return;
  }

  const { conflictCount, legacyCount, targetCount } =
    await countColumnValueStats(table, legacy, target);
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
      `UPDATE ${table} SET ${target} = ${legacy} WHERE ${target} IS NULL`,
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
    await runMigration(`ALTER TABLE ${table} DROP COLUMN ${legacy}`);
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
    await repairLegacyColumnRename(table, legacy, target);
  }
};
