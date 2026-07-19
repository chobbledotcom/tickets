import { okResult, type Result } from "#shared/result.ts";

export interface DatabaseCredentials {
  dbId: string;
  dbToken: string;
  dbUrl: string;
}

export const databaseCredentialsFromResponse = (
  dbId: string,
  dbUrl: string,
  text: string,
  tokenKey: string,
): Result<DatabaseCredentials> => {
  const token = JSON.parse(text)[tokenKey];
  if (typeof token !== "string") {
    throw new Error(`Database response is missing ${tokenKey}`);
  }
  return okResult({ dbId, dbToken: token, dbUrl });
};

/** Create a site on a hosting provider: deploy `code` under `name` with the
 * given secrets, returning the new site's id and default hostname. Declared
 * once so every provider implementation shares the exact same signature. */
export type CreateSiteFn = (
  name: string,
  code: string,
  secrets: [string, string][],
) => Promise<Result<{ hostingId: string; defaultHostname: string }>>;

export interface HostingProviderApi {
  configEnvVar: string;
  createSite: CreateSiteFn;
  getSecretNames(hostingId: string): Promise<Result<string[]>>;
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

export interface DatabaseProviderApi {
  createDatabase: CreateDatabaseFn;
}
