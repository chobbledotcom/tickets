import type { Client, ResultSet } from "@libsql/client";

/**
 * A ResultSet answering with the given plain rows (and affected count). libsql
 * types its rows as a Record/ArrayLike hybrid no plain record list satisfies,
 * so the records re-enter that shape at this one cast — the same boundary
 * `resultRows` draws in src. Omitted members (toJSON) are never called by the
 * exercised paths.
 */
export const stubResultSet = (
  rows: Record<string, unknown>[],
  rowsAffected = 0,
): ResultSet =>
  ({
    columns: [],
    columnTypes: [],
    lastInsertRowid: undefined,
    rows,
    rowsAffected,
  }) as unknown as ResultSet;

/** A minimal libsql ResultSet for stubbed execute/batch calls. */
export const emptyResultSet = (): ResultSet => stubResultSet([]);

/**
 * A database client standing in for the guarded client a test installs with
 * `setDb`. The test names only the members its exercised path calls, so an
 * omitted member stays absent. The one unsafe cast lives here, not at every
 * call site.
 */
export const stubClient = (members: Partial<Client>): Client =>
  members as Client;
