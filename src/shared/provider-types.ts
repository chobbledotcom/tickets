import type { ApiResult } from "#shared/fetch.ts";

export interface HostingProviderApi {
  configEnvVar: string;
  createSite(
    name: string,
    code: string,
    secrets: [string, string][],
  ): Promise<ApiResult<{ hostingId: string; defaultHostname: string }>>;
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
