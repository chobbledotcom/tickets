import type { Client, InStatement, ResultSet } from "@libsql/client";
import { getDb, setDb } from "#db/client.ts";
import { wrapExecute } from "#db/libsql-call.ts";
import { proxyMembers } from "#shared/proxy-members.ts";

type BatchStatement = Parameters<ReturnType<typeof getDb>["batch"]>[0][number];

/** The SQL text of a statement in either InStatement form. */
export const statementSql = (
  statement: BatchStatement | InStatement | string,
): string =>
  Array.isArray(statement)
    ? statement[0]
    : typeof statement === "string"
      ? statement
      : statement.sql;

export type DbCallHooks = {
  /** Take over the statement by returning a promise, or null to forward. */
  execute: (statement: InStatement | string) => Promise<ResultSet> | null;
  /** Observe a batch's statements before they forward. */
  batch: (statements: InStatement[], mode?: "write" | "read") => void;
};

/** Swap the db client for a proxy that observes or intercepts statements
 *  (including raw boot-path queries); everything else forwards to the real
 *  client. Returns a restore function. */
export const wrapDbClient = (hooks: DbCallHooks): (() => void) => {
  const real = getDb();
  setDb(
    proxyMembers(real, {
      batch: (statements: InStatement[], mode?: "write" | "read") => {
        hooks.batch(statements, mode);
        return real.batch(statements, mode);
      },
      execute: wrapExecute(
        real,
        (statement, execute) => hooks.execute(statement) ?? execute(),
      ),
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
      transaction: async (...args: Parameters<Client["transaction"]>) => {
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
      record(`batch[${statements.map(statementSql).join(" | ")}]`);
    },
    execute: (statement) => {
      record(statementSql(statement));
      return null;
    },
  });
};
