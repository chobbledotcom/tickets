import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { withMocks } from "#test-utils/mocks.ts";

type CreateResult = Awaited<ReturnType<typeof bunnyCdnApi.createEdgeScript>>;
type BunnyResult = Awaited<ReturnType<typeof bunnyCdnApi.publishEdgeScript>>;
type CreateDbResult = Awaited<ReturnType<typeof builderApi.createDatabase>>;

/** Standard auto-created-database result used across builder tests. */
export const MOCK_DB_RESULT = {
  dbId: "db_auto123",
  dbToken: "auto-token",
  dbUrl: "libsql://auto.lite.bunnydb.net",
  ok: true as const,
};

interface ReleaseOptions {
  name?: string;
  assetUrl?: string;
  assets?: unknown[];
}

/** A GitHub `releases/latest` JSON response carrying one downloadable asset. */
export const releaseResponse = (opts: ReleaseOptions = {}): Response =>
  new Response(
    JSON.stringify({
      assets: opts.assets ?? [
        {
          browser_download_url:
            opts.assetUrl ?? "https://example.com/script.ts",
          name: "bunny-script.ts",
        },
      ],
      name: opts.name ?? "Test",
      published_at: "2026-01-01T00:00:00Z",
      tag_name: "v2026-01-01-000000",
    }),
    { status: 200 },
  );

/**
 * Stub `fetch` for builder tests: `releases/latest` returns the standard release
 * JSON, every other URL is delegated to `onOther` (default: 200 with "code").
 */
export const stubBuilderFetch = (
  onOther: (url: string) => Response = () =>
    new Response("code", { status: 200 }),
  releaseOpts?: ReleaseOptions,
) =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    return Promise.resolve(
      url.includes("releases/latest")
        ? releaseResponse(releaseOpts)
        : onOther(url),
    );
  });

interface BuildSiteMockOptions {
  defaultHostname?: string;
  pullZoneId?: number;
  scriptId?: number;
  encryptionKey?: string;
  onOther?: (url: string) => Response;
  releaseOpts?: ReleaseOptions;
  createResult?: CreateResult;
  publishResult?: BunnyResult;
  secretResult?: BunnyResult;
  updatePullZoneResult?: BunnyResult;
  createDbResult?: CreateDbResult;
}

/**
 * Every stub `builderApi.buildSite` exercises: the GitHub release fetch, the
 * edge-script create/publish/secret/pull-zone calls, the encryption-key
 * generator, and the auto database creator. Each step defaults to its happy-path
 * result; pass a `*Result` override to drive a specific error path. The returned
 * stubs expose `.calls` for asserting what `buildSite` did.
 */
export const stubBuildSiteApis = (opts: BuildSiteMockOptions = {}) => ({
  createDbStub: stub(builderApi, "createDatabase", () =>
    Promise.resolve(opts.createDbResult ?? MOCK_DB_RESULT),
  ),
  createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
    Promise.resolve(
      opts.createResult ?? {
        defaultHostname: opts.defaultHostname ?? "https://test-42.b-cdn.net",
        ok: true as const,
        pullZoneId: opts.pullZoneId ?? 99,
        scriptId: opts.scriptId ?? 42,
      },
    ),
  ),
  encKeyStub: stub(
    builderApi,
    "generateEncryptionKey",
    () => opts.encryptionKey ?? "dGVzdGtleQ==",
  ),
  fetchStub: stubBuilderFetch(opts.onOther, opts.releaseOpts),
  publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
    Promise.resolve(opts.publishResult ?? { ok: true as const }),
  ),
  secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve(opts.secretResult ?? { ok: true as const }),
  ),
  updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
    Promise.resolve(opts.updatePullZoneResult ?? { ok: true as const }),
  ),
});

/** Install the full happy-path buildSite mock bundle for the duration of `body`. */
export const withBuildSiteMocks = (
  body: (mocks: ReturnType<typeof stubBuildSiteApis>) => void | Promise<void>,
  opts?: BuildSiteMockOptions,
): Promise<void> => withMocks(() => stubBuildSiteApis(opts), body);

/** The [name, value] secret pairs a `setEdgeScriptSecret` stub recorded. */
export const secretsFrom = (secretStub: {
  calls: ReadonlyArray<{ args: readonly unknown[] }>;
}): [string, string][] =>
  secretStub.calls.map((c) => [c.args[1] as string, c.args[2] as string]);

/** Assert a secret with `name` was set to exactly `value`. */
export const expectSecret = (
  secrets: [string, string][],
  name: string,
  value: string,
): void => {
  const found = secrets.find(([n]) => n === name);
  expect(found).toBeDefined();
  expect(found![1]).toBe(value);
};

/** Assert a failed `buildSite` result whose error contains `substring`. */
export const expectBuildError = (
  result: Awaited<ReturnType<typeof builderApi.buildSite>>,
  substring: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(substring);
};
