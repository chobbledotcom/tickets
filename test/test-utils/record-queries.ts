import type { InArgs, InStatement, ResultSet } from "@libsql/client";
import { getDb, setDb } from "#shared/db/client.ts";

/** The SQL text of a statement in either InStatement form. */
export const statementSql = (statement: InStatement | string): string =>
  typeof statement === "string" ? statement : statement.sql;

export type DbCallHooks = {
  /** Take over the statement by returning a promise, or null to forward. */
  execute: (statement: InStatement | string) => Promise<ResultSet> | null;
  /** Observe a batch's statements before they forward. */
  batch: (statements: InStatement[]) => void;
};

/**
 * Swap the db client for a proxy that lets a test observe or intercept
 * statements — including raw boot-path queries that bypass the tracked
 * client helpers. Everything else forwards to the real client (plain values
 * as-is, methods bound so they keep working). Returns a restore function.
 */
export const wrapDbClient = (hooks: DbCallHooks): (() => void) => {
  const real = getDb();
  setDb(
    new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (statement: InStatement | string, args?: InArgs) =>
            hooks.execute(statement) ??
            (typeof statement === "string" && args !== undefined
              ? target.execute(statement, args)
              : target.execute(statement as InStatement));
        }
        if (prop === "batch") {
          return (statements: InStatement[], mode?: "write" | "read") => {
            hooks.batch(statements);
            return target.batch(statements, mode);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  return () => setDb(real);
};

/**
 * Wrap the current db client so every statement lands in `seen` (whitespace
 * collapsed; batches recorded as one `batch[a | b]` entry). Returns a restore
 * function. Tests use this to assert exactly which queries an operation runs.
 */
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
