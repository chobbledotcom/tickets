/**
 * Who runs a database, worked out from its address alone. This module is pure:
 * callers pass a URL, it never reads the environment.
 */
import { errorResult, okResult, type Result } from "#shared/result.ts";

export type DatabaseHost = "bunny" | "turso" | "local" | "other";

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

/** One database as its provider lists it: the provider's own id, and the host
 * the database's clients connect to. */
export interface ListedDatabase {
  host: string;
  id: string;
}

/** The host an address reaches. */
export const addressHost = (url: string): string => new URL(url).hostname;

/** The listed database a site's address reaches, or the refusal that names the
 * provider. A list the provider refused answers that refusal. A site and its
 * provider must agree on the address before the host can change that
 * database's key. */
export const requireListedDatabase = (
  listed: Result<ListedDatabase[]>,
  dbUrl: string,
  providerName: string,
): Result<ListedDatabase> => {
  if (!listed.ok) return listed;
  const host = addressHost(dbUrl);
  const found = listed.value.find((database) => database.host === host);
  return found
    ? okResult(found)
    : errorResult(`No ${providerName} database has the address ${host}.`);
};
