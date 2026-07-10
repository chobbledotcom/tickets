import type { InArgs, InStatement } from "@libsql/client";
import { getDb, setDb } from "#shared/db/client.ts";

/** The SQL text of a statement in either InStatement form. */
const statementSql = (statement: InStatement | string): string =>
  typeof statement === "string" ? statement : statement.sql;

/**
 * Wrap the current db client so every statement lands in `seen` (whitespace
 * collapsed; batches recorded as one `batch[a | b]` entry). Returns a restore
 * function. Tests use this to assert exactly which queries an operation runs —
 * including raw boot-path queries that bypass the tracked client helpers.
 */
export const recordQueries = (seen: string[]): (() => void) => {
  const real = getDb();
  const record = (sql: string): void => {
    seen.push(sql.replace(/\s+/g, " "));
  };
  setDb(
    new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (statement: InStatement | string, args?: InArgs) => {
            record(statementSql(statement));
            return typeof statement === "string" && args !== undefined
              ? target.execute(statement, args)
              : target.execute(statement as InStatement);
          };
        }
        if (prop === "batch") {
          return (statements: InStatement[], mode?: "write" | "read") => {
            record(`batch[${statements.map(statementSql).join(" | ")}]`);
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
