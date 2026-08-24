import type { InValue } from "@libsql/client";
import type { SqlStatement } from "#db/client.ts";

declare const SQL_TOKEN: unique symbol;
export type SqlParameterToken = string & { readonly [SQL_TOKEN]: true };
export type SqlParameter = (value: InValue) => SqlParameterToken;
export type NumberedSql = (bind: SqlParameter) => string;

export const numberedStatement = (buildSql: NumberedSql): SqlStatement => {
  const args: InValue[] = [];
  const bind: SqlParameter = (value) =>
    `?${args.push(value)}` as SqlParameterToken;
  return { args, sql: buildSql(bind) };
};

/** The condition that always holds, for a guard with nothing left to check. */
export const ALWAYS_TRUE = "1 = 1";

/** AND several conditions into one, each kept inside its own parentheses.
 * With nothing to check the result always holds. */
export const allConditions =
  (conditions: readonly NumberedSql[]): NumberedSql =>
  (bind) =>
    conditions.length === 0
      ? ALWAYS_TRUE
      : conditions.map((condition) => `(${condition(bind)})`).join(" AND ");
