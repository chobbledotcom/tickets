import type { ApiResult } from "#shared/fetch.ts";

/** Create a site on a hosting provider: deploy `code` under `name` with the
 * given secrets, returning the new site's id and default hostname. Declared
 * once so every provider implementation shares the exact same signature. */
export type CreateSiteFn = (
  name: string,
  code: string,
  secrets: [string, string][],
) => Promise<ApiResult<{ hostingId: string; defaultHostname: string }>>;

export interface HostingProviderApi {
  configEnvVar: string;
  createSite: CreateSiteFn;
  getSecretNames(hostingId: string): Promise<ApiResult<{ names: string[] }>>;
  setSecrets(
    hostingId: string,
    secrets: [string, string][],
  ): Promise<ApiResult<Record<never, never>>>;
}

export interface DatabaseProviderApi {
  createDatabase(
    name: string,
  ): Promise<ApiResult<{ dbId: string; dbUrl: string; dbToken: string }>>;
}
