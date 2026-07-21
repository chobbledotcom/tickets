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

export interface DatabaseProviderApi {
  createDatabase: CreateDatabaseFn;
}
