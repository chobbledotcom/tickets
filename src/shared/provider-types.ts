// effects: pure
import type { Result } from "#shared/result.ts";

export interface DatabaseCredentials {
  dbId: string;
  dbToken: string;
  dbUrl: string;
}

/** The token out of one provider reply. A reply that carries no token breaks
 * the provider's contract, so it throws rather than returning a blank token. */
export const databaseTokenFromResponse = (
  text: string,
  tokenKey: string,
): string => {
  const token = JSON.parse(text)[tokenKey];
  if (typeof token !== "string") {
    throw new Error(`Database response is missing ${tokenKey}`);
  }
  return token;
};

export type PrepareSiteFn = (
  name: string,
  code: string,
  secrets: [string, string][],
) => Promise<Result<{ hostingId: string; defaultHostname: string }>>;

export interface HostingProviderApi {
  configEnvVar: string;
  getSecretNames(hostingId: string): Promise<Result<string[]>>;
  prepareSite: PrepareSiteFn;
  publishSite(hostingId: string, code: string): Promise<Result<void>>;
  setSecrets(
    hostingId: string,
    secrets: [string, string][],
  ): Promise<Result<void>>;
}

/** Create a database named `name` on a database provider, returning the new
 * database's id, URL, and a full-access token. Declared once so every provider
 * implementation shares the exact same signature. */
export type CreateDatabaseFn = (
  name: string,
) => Promise<Result<DatabaseCredentials>>;

/** Make every access key for the database a site reaches at `dbUrl` stop
 * working. The provider needs a short downtime to finish the change, so the
 * new key is asked for later, as its own step. */
export type InvalidateDatabaseTokensFn = (
  dbUrl: string,
) => Promise<Result<void>>;

/** One new full-access key for the database a site reaches at `dbUrl`.
 * Declared once so every provider implementation shares the signature. */
export type IssueDatabaseTokenFn = (dbUrl: string) => Promise<Result<string>>;

export interface DatabaseProviderApi {
  createDatabase: CreateDatabaseFn;
  invalidateDatabaseTokens: InvalidateDatabaseTokensFn;
  issueDatabaseToken: IssueDatabaseTokenFn;
}
