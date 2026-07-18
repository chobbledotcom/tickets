import type { ApiResult } from "#shared/fetch.ts";

export type PrepareSiteFn = (
  name: string,
  code: string,
  secrets: [string, string][],
) => Promise<ApiResult<{ hostingId: string; defaultHostname: string }>>;

export interface HostingProviderApi {
  configEnvVar: string;
  getSecretNames(hostingId: string): Promise<ApiResult<{ names: string[] }>>;
  prepareSite: PrepareSiteFn;
  promoteSecrets(
    hostingId: string,
    primary: [string, string],
    removeName: string,
  ): Promise<ApiResult<Record<never, never>>>;
  publishSite(
    hostingId: string,
    code: string,
  ): Promise<ApiResult<Record<never, never>>>;
  setSecrets(
    hostingId: string,
    secrets: [string, string][],
  ): Promise<ApiResult<Record<never, never>>>;
}

/** Create a database named `name` on a database provider, returning the new
 * database's id, URL, and a full-access token. Declared once so every provider
 * implementation shares the exact same signature. */
export type CreateDatabaseFn = (
  name: string,
) => Promise<ApiResult<{ dbId: string; dbUrl: string; dbToken: string }>>;

export interface DatabaseProviderApi {
  createDatabase: CreateDatabaseFn;
}
