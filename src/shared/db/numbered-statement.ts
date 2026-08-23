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
