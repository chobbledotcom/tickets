import type { ResultSet } from "@libsql/client";
import { getDb, type StatementClient, setDb } from "#db/client.ts";
import type { SqlStatement } from "#db/sql.ts";
import { proxyMembers } from "#shared/proxy-members.ts";

export type DbCallHooks = {
  /** Take over the statement by returning a promise, or null to forward. */
  execute: (statement: SqlStatement) => Promise<ResultSet> | null;
  /** Observe a batch's statements before they forward. */
  batch: (statements: SqlStatement[], mode?: "write" | "read") => void;
};

/** Swap the db client for a proxy that observes or intercepts statements
 *  (including raw boot-path queries); everything else forwards to the real
 *  client. Returns a restore function. */
export const wrapDbClient = (hooks: DbCallHooks): (() => void) => {
  const real = getDb();
  setDb(
    proxyMembers(real, {
      batch: (statements: SqlStatement[], mode?: "write" | "read") => {
        hooks.batch(statements, mode);
        return real.batch(statements, mode);
      },
      execute: (statement: SqlStatement) =>
        hooks.execute(statement) ?? real.execute(statement),
    }),
  );
  return () => setDb(real);
};

/** Run one callback immediately before the next database transaction starts. */
export const beforeNextTransaction = (
  before: () => Promise<void>,
): (() => void) => {
  const real = getDb();
  let pending = true;
  setDb(
    proxyMembers(real, {
      transaction: async (
        ...args: Parameters<StatementClient["transaction"]>
      ) => {
        if (pending) {
          pending = false;
          await before();
        }
        return real.transaction(...args);
      },
    }),
  );
  return () => setDb(real);
};

/** Record every statement into `seen` (whitespace collapsed; batches as one
 *  `batch[a | b]` entry). Returns a restore function. */
export const recordQueries = (seen: string[]): (() => void) => {
  const record = (sql: string): void => {
    seen.push(sql.replace(/\s+/g, " "));
  };
  return wrapDbClient({
    batch: (statements) => {
      record(
        `batch[${statements.map((statement) => statement.sql).join(" | ")}]`,
      );
    },
    execute: (statement) => {
      record(statement.sql);
      return null;
    },
  });
};
