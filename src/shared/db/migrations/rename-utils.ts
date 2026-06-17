import { countRows, getDb } from "#shared/db/client.ts";
import {
  getExistingColumns,
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

const columnRenameState = async (
  table: string,
  legacy: string,
  target: string,
): Promise<RenameState> => {
  const cols = await getExistingColumns(table);
  return renameState(cols.has(legacy), cols.has(target));
};

const countRowsWhere = async (
  table: string,
  where: string,
): Promise<number> => {
  const result = await getDb().execute(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  );
  return Number(result.rows[0]?.n ?? 0);
};

const countColumnValues = (table: string, column: string): Promise<number> =>
  countRowsWhere(table, `${column} IS NOT NULL`);

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
    sql: "SELECT name, sql FROM sqlite_master " +
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

const repairLegacyColumnRename = async (
  table: string,
  legacy: string,
  target: string,
): Promise<void> => {
  if (!(await tableExists(table))) return;

  const state = await columnRenameState(table, legacy, target);
  if (
    await applyDirectRename(
      state,
      `ALTER TABLE ${table} RENAME COLUMN ${legacy} TO ${target}`,
    )
  ) {
    return;
  }

  const [legacyCount, targetCount] = await Promise.all([
    countColumnValues(table, legacy),
    countColumnValues(table, target),
  ]);
  if (legacyCount > 0 && targetCount > 0) {
    throw new Error(
      `Cannot migrate "${table}.${legacy}" -> "${table}.${target}": both ` +
        `columns contain data (${legacyCount} legacy row(s), ` +
        `${targetCount} target row(s)). Manual migration is required — ` +
        "back up the database, merge the legacy column values into the " +
        "target by hand, drop the legacy column, then re-run the migration.",
    );
  }

  if (legacyCount > 0) {
    await runMigration(`UPDATE ${table} SET ${target} = ${legacy}`);
  }
  await dropProjectIndexesReferencingColumn(table, legacy);
  await runMigration(`ALTER TABLE ${table} DROP COLUMN ${legacy}`);
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
