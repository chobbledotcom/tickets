import * as v from "valibot";

/**
 * Who runs a database, worked out from its address alone. This module is pure:
 * callers pass a URL, it never reads the environment.
 */
const DatabaseHostSchema = v.picklist(["bunny", "turso", "local", "other"]);
export type DatabaseHost = v.InferOutput<typeof DatabaseHostSchema>;

/** The address endings that name the company running a hosted database. */
const HOSTED_ENDINGS: Record<"bunny" | "turso", string> = {
  bunny: ".bunnydb.net",
  turso: ".turso.io",
};

/** Database addresses that are not one of these are a local file. */
const REMOTE_SCHEMES = ["libsql:", "https:"];

/** Name the company running the database at this address. */
export const databaseHostFor = (url: string): DatabaseHost => {
  if (!URL.canParse(url)) return "local";
  const { hostname, protocol } = new URL(url);
  if (!REMOTE_SCHEMES.includes(protocol)) return "local";
  const hosted = Object.entries(HOSTED_ENDINGS).find(([, ending]) =>
    hostname.endsWith(ending),
  );
  return hosted ? (hosted[0] as DatabaseHost) : "other";
};
