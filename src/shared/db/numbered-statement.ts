import type { InValue } from "@libsql/client";
import type { SqlStatement } from "#db/client.ts";

export type SqlParameterToken = `?${number}` & { readonly sql: unique symbol };
export type SqlParameter = (value: InValue) => SqlParameterToken;
export type NumberedSql = (bind: SqlParameter) => string;

export const numberedStatement = (buildSql: NumberedSql): SqlStatement => {
  const args: InValue[] = [];
  const bind: SqlParameter = (value) =>
    `?${args.push(value)}` as SqlParameterToken;
  return { args, sql: buildSql(bind) };
};
