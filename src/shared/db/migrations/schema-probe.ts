/** The live-schema probe: one batched read that answers "what exists right
 * now" for the schema steps, plus the per-table column and table probes. */

import { getDb, queryBatchPrimary } from "#db/client.ts";
import { stringColumnSet } from "#db/query.ts";
import { queryRowsWithArg } from "./master-query.ts";

/** Get the set of existing column names for a table */
export const getExistingColumns = async (
  table: string,
): Promise<Set<string>> => {
  const result = await getDb().execute(`PRAGMA table_info(${table})`);
  return stringColumnSet(result.rows, "name");
};

export const tableExists = async (table: string): Promise<boolean> => {
  const rows = await queryRowsWithArg(
    getDb(),
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  return rows.length > 0;
};

/** Each table's live column names, keyed by table name. */
export type LiveTables = Map<string, Set<string>>;

/** Live schema snapshot: every table's columns, every index, every trigger. */
export type LiveSchema = {
  /** table name → set of its column names */
  tables: LiveTables;
  /** all index names present (including sqlite_autoindex_*) */
  indexes: Set<string>;
  /** all trigger names present */
  triggers: Set<string>;
};

/**
 * Two SELECTs in one read batch, because an edge request caps outbound
 * subrequests and a per-table probe loop spends dozens of them.
 *
 * Pinned to the primary, not a replica: every caller runs inside a migration,
 * where the snapshot must reflect DDL applied moments earlier. A lagging
 * replica reports a just-created table as missing and fails verify() spuriously.
 */
export const snapshotLiveSchema = async (): Promise<LiveSchema> => {
  const [columns, indexRows, triggerRows] = await queryBatchPrimary([
    {
      args: [],
      sql:
        "SELECT master.name AS tbl, tableInfo.name AS col " +
        "FROM sqlite_master AS master JOIN pragma_table_info(master.name) AS tableInfo " +
        "WHERE master.type = 'table'",
    },
    {
      args: [],
      sql: "SELECT name FROM sqlite_master WHERE type = 'index'",
    },
    {
      args: [],
      sql: "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    },
  ]);

  const tables = new Map<string, Set<string>>();
  for (const row of columns!.rows) {
    const tbl = String(row.tbl);
    const cols = tables.get(tbl) ?? new Set<string>();
    cols.add(String(row.col));
    tables.set(tbl, cols);
  }

  const indexes = stringColumnSet(indexRows!.rows, "name");
  const triggers = stringColumnSet(triggerRows!.rows, "name");
  return { indexes, tables, triggers };
};

/** Build a sync/verify step that first loads its live-schema probe — the whole
 * snapshot or one table's columns — then hands it to the work. Every step
 * below opens with the same read, so the probe lives here once. */
const stepUsing =
  <Probe>(loadProbe: () => Promise<Probe>) =>
  (work: (probe: Probe) => Promise<void>) =>
  async (): Promise<void> =>
    work(await loadProbe());

/** Steps that work from one whole-schema snapshot (a single batched read). */
export const fromLiveSchema = stepUsing(snapshotLiveSchema);

/** Steps that fork on the live attendees table's columns — the legacy-schema
 * probe the attendee backfills and the legacy-column drop all open with. */
export const fromAttendeeColumns = stepUsing(() =>
  getExistingColumns("attendees"),
);
