/**
 * The suite for a migration that adds one column with a default: a stored row
 * keeps the default after the upgrade, and the migration declares every object
 * it owns. Each dated migration test that adds a column supplies its facts, so
 * the upgrade steps live here once.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import type { MigrationBuilder } from "#db/migrations/types.ts";
import { type SqlStatement, sql, sqlName } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

/** What one column-adding migration must hold. */
type ColumnMigration = {
  /** The column the migration adds. */
  column: string;
  /** The declaration the "declares every object it owns" test checks, when the
   * suite has that test. */
  declared?: { description: string; id: string };
  /** The value a stored row holds for the column after the upgrade. */
  defaultValue: number;
  /** Extra tests this migration's suite holds. */
  extraTests?: () => void;
  /** The row stored before the upgrade, as one whole insert. */
  insertRow: SqlStatement;
  /** The migration module's default export. */
  migration: MigrationBuilder;
  /** The suite name. */
  name: string;
  /** The id of the stored row. */
  rowId: number;
  /** The table the migration adds its column to. */
  table: string;
  /** The name of the adds-the-default test. */
  title: string;
};

export const describeColumnMigration = (spec: ColumnMigration): void => {
  const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
  const migration = () => spec.migration(context);
  describeWithEnv(spec.name, { db: true }, () => {
    test(spec.title, async () => {
      await getDb().execute(spec.insertRow);
      await getDb().execute(
        sql`ALTER TABLE ${sqlName(spec.table)} DROP COLUMN ${sqlName(spec.column)}`,
      );

      await migration().up();

      expect((await getExistingColumns(spec.table)).has(spec.column)).toBe(
        true,
      );
      const result = await getDb().execute(
        sql`SELECT ${sqlName(spec.column)} FROM ${sqlName(spec.table)}
           WHERE id = ${spec.rowId}`,
      );
      expect(Number(result.rows[0]?.[spec.column])).toBe(spec.defaultValue);
    });
    const declared = spec.declared;
    if (declared) {
      test("declares every object it owns", () => {
        // Anything left off this list is never verified, so a partial upgrade
        // would record itself as applied.
        expect(migration().id).toBe(declared.id);
        expect(migration().requires).toEqual({
          columns: { [spec.table]: [spec.column] },
        });
        expect(migration().description).toBe(declared.description);
      });
    }
    spec.extraTests?.();
  });
};
