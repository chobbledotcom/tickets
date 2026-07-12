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
 * Direction matters. Re-adding is only legitimate for a dump that is OLDER
 * than this build — one whose recorded migrations are missing at least one of
 * ours, so a pending migration exists to consume the re-added columns. A dump
 * that records migrations dated after this build's newest is from a NEWER
 * build: replaying it would silently discard newer-schema data
 * (restoreFromZip skips tables the current schema lacks), so the restore must
 * refuse it up front instead of making the rollback look successful. And when
 * the recorded migrations leave nothing pending, an unknown column is
 * corruption, not history — nothing may be re-added, and the INSERT fails
 * loudly. dumpMigrationState answers both questions from the dump itself.
 *
 * This module is pure: dump statements in, ALTER statements / analysis out.
 */

import { mapNotNullish } from "#fp";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";

/** The `INSERT INTO "table" ("col", …) VALUES` prefix exportTable emits. */
const INSERT_COLUMNS = /^INSERT INTO "(\w+)" \(([^)]+)\) VALUES /;

/** The exportTable-shaped INSERTs in a dump: each statement's target table
 *  and raw quoted column list. Non-matching statements are skipped. */
const dumpInserts = (
  statements: string[],
): { table: string; columnList: string; statement: string }[] =>
  mapNotNullish((statement: string) => {
    const insert = statement.match(INSERT_COLUMNS);
    return insert
      ? { columnList: insert[2]!, statement, table: insert[1]! }
      : null;
  })(statements);

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

/** A migration id as a quoted SQL literal, e.g. '2026-07-05_first_class_images'
 *  — the date prefix keeps applied_at timestamps ('2026-07-05T14:45:07.397Z')
 *  and prose descriptions from matching. */
const MIGRATION_ID_LITERAL = /'(\d{4}-\d{2}-\d{2}_[\w-]+)'/g;

/** A migration id's date part ("YYYY-MM-DD_name" → "YYYY-MM-DD"). */
const migrationDate = (id: string): string => id.slice(0, 10);

/** How the dump's recorded schema_migrations relate to this build's. */
export type DumpMigrationState = {
  /** Recorded ids that can only have come from a newer build — dated after
   *  this build's newest migration, or dated the same but with nothing
   *  pending (see dumpMigrationState). The dump must not be replayed here.
   *  Unrecognised ids dated within this build's history are tolerated: real
   *  databases carry orphaned markers from historically renamed migrations
   *  (e.g. 2026-06-18_answer_price_modifiers), which nothing cleans up. */
  fromNewerBuild: string[];
  /** True when the dump is missing at least one of this build's migrations —
   *  the dump is older, and those migrations will replay on the next boot. */
  hasPending: boolean;
};

/**
 * Read the migration ids the dump's schema_migrations INSERTs record and
 * relate them to this build's known ids. Ids are date-prefixed and a new
 * migration is always dated on or after the newest one already shipped, so a
 * recorded id with a later date than any known id can only come from a newer
 * build. An unrecognised id sharing the newest date is ambiguous — a same-day
 * migration from a newer build, or an orphaned marker from a same-day rename
 * — so it fails closed as "newer" unless the dump is missing one of this
 * build's migrations, which proves the dump predates it. A dump with no
 * schema_migrations statements (partial fixtures, plain SQL) reads as fully
 * pending.
 */
/** The migration ids the dump's schema_migrations INSERTs record. */
const recordedMigrationIds = (statements: string[]): Set<string> =>
  new Set(
    dumpInserts(statements)
      .filter((insert) => insert.table === "schema_migrations")
      .flatMap((insert) =>
        [...insert.statement.matchAll(MIGRATION_ID_LITERAL)].map(
          (match) => match[1]!,
        ),
      ),
  );

export const dumpMigrationState = (
  statements: string[],
  knownIds: readonly string[],
): DumpMigrationState => {
  const recorded = recordedMigrationIds(statements);
  const known = new Set(knownIds);
  const newestKnownDate = knownIds.reduce(
    (newest, id) => (migrationDate(id) > newest ? migrationDate(id) : newest),
    "",
  );
  const hasPending = knownIds.some((id) => !recorded.has(id));
  const isFromNewerBuild = (id: string): boolean => {
    if (known.has(id)) return false;
    const date = migrationDate(id);
    return date > newestKnownDate || (date === newestKnownDate && !hasPending);
  };
  return {
    fromNewerBuild: [...recorded].filter(isFromNewerBuild),
    hasPending,
  };
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
  for (const insert of dumpInserts(statements)) {
    const declared = declaredColumns.get(insert.table);
    const columns = declared ? parseColumnList(insert.columnList) : null;
    if (!declared || !columns) continue;
    for (const column of columns) {
      const key = `${insert.table}.${column}`;
      if (declared.has(column) || restored.has(key)) continue;
      restored.add(key);
      restores.push(`ALTER TABLE "${insert.table}" ADD COLUMN "${column}"`);
    }
  }
  return restores;
};
