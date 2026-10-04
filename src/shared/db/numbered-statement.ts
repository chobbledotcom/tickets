import type { InValue } from "@libsql/client";
import type { SqlStatement } from "#db/client.ts";

export type SqlParameterToken = `?${number}` & { readonly sql: unique symbol };
export type SqlParameter = (value: InValue) => SqlParameterToken;
export type NumberedSql = (bind: SqlParameter) => string;

export const numberedStatement = (buildSql: NumberedSql): SqlStatement => {
  const args: InValue[] = [];
  // Two occurrences of one value read the same argument, so an already bound
  // value reuses its token. Equal primitives are the same value; repeated
  // dates across cart buckets then collapse to one slot per distinct value.
  const byValue = new Map<InValue, SqlParameterToken>();
  const bind: SqlParameter = (value) => {
    const bound = byValue.get(value);
    if (bound) return bound;
    const token = `?${args.push(value)}` as SqlParameterToken;
    byValue.set(value, token);
    return token;
  };
  return { args, sql: buildSql(bind) };
};
