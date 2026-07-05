/**
 * Reconcile an older backup's dump with the current schema before replaying it.
 *
 * A restore rebuilds the database at the CURRENT schema and then replays the
 * backup's INSERT statements; the backup's own schema_migrations rows make the
 * next boot replay whichever migrations the backup predates. That round-trips
 * cleanly for tables and columns that were ADDED since the backup — but a
 * column a later migration DROPPED breaks the replay, because the dump's
 * INSERTs still write to it. Re-adding those columns before the replay
 * reconstructs the backup-era table faithfully, and the pending migration then
 * reshapes the data exactly as a live upgrade would (e.g.
 * 2026-07-05_first_class_images backfills images from the re-added
 * listings.image_url and drops the column again).
 *
 * This module is pure: dump statements in, ALTER statements out.
 */

import { SCHEMA } from "#shared/db/migrations/schema.ts";

/** The `INSERT INTO "table" ("col", …) VALUES` prefix exportTable emits. */
const INSERT_COLUMNS = /^INSERT INTO "(\w+)" \(([^)]+)\) VALUES /;

/** A single double-quoted plain identifier, e.g. `"image_url"`. */
const QUOTED_IDENTIFIER = /^"(\w+)"$/;

/** Column names each declared table carries in the current schema. */
const currentSchemaColumns = (): Map<string, Set<string>> =>
  new Map(
    SCHEMA.map(([name, table]) => [
      name,
      new Set(table.columns.map(([column]) => column)),
    ]),
  );

/** Parse a dump statement's quoted column list into names — or null when any
 *  token is not a plain quoted identifier (a hand-edited dump; leave it for
 *  the INSERT itself to reject). */
const parseColumnList = (list: string): string[] | null => {
  const names: string[] = [];
  for (const token of list.split(", ")) {
    const match = token.match(QUOTED_IDENTIFIER);
    if (!match) return null;
    names.push(match[1]!);
  }
  return names;
};

/**
 * ALTER statements re-adding every column the dump writes to a declared table
 * but the current schema no longer carries. The column is added without a type:
 * SQLite then gives it BLOB affinity, so replayed values are stored exactly as
 * the dump's literals encode them, and the pending migration that dropped the
 * column decides its fate on the next boot.
 */
export const legacyColumnRestores = (statements: string[]): string[] => {
  const declaredColumns = currentSchemaColumns();
  const restores: string[] = [];
  const restored = new Set<string>();
  for (const statement of statements) {
    const insert = statement.match(INSERT_COLUMNS);
    const declared = insert && declaredColumns.get(insert[1]!);
    const columns = declared ? parseColumnList(insert[2]!) : null;
    if (!declared || !columns) continue;
    for (const column of columns) {
      const key = `${insert[1]}.${column}`;
      if (declared.has(column) || restored.has(key)) continue;
      restored.add(key);
      restores.push(`ALTER TABLE "${insert[1]}" ADD COLUMN "${column}"`);
    }
  }
  return restores;
};
