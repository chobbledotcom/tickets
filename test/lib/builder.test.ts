import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { bunnyDbProvider as bunnyDbApi } from "#shared/bunny-db.ts";
import { tursoDbProvider as tursoApi } from "#shared/turso-api.ts";
import { describeWithEnv, setTestEnv, withMocks } from "#test-utils";
import {
  expectBuildError,
  expectSecret,
  MOCK_DB_RESULT,
  secretsFrom,
  stubBuilderFetch,
  stubBuildSiteApis,
  stubDenoBuilderApis,
  withBuildSiteMocks,
} from "#test-utils/builder-mocks.ts";

const BUILD_INPUT = {
  dbToken: "token123",
  dbUrl: "libsql://test.turso.io",
  siteName: "Test",
} as const;

type Restorable = { restore(): void };

/** Each error path: install mocks, call buildSite, expect a matching failure. */
const ERROR_CASES: {
  name: string;
  mocks: () => Restorable | Record<string, Restorable>;
  input: Parameters<typeof builderApi.buildSite>[0];
  error: string;
}[] = [
  {
    error: "No release asset",
    input: BUILD_INPUT,
    mocks: () => stubBuilderFetch(undefined, { assets: [] }),
    name: "buildSite returns error when release has no asset",
  },
  {
    error: "Failed to fetch release",
    input: BUILD_INPUT,
    mocks: () =>
      stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("Not Found", { status: 404 })),
      ),
    name: "buildSite returns error when GitHub API fails",
  },
  {
    error: "Failed to download release",
    input: BUILD_INPUT,
    mocks: () =>
      stubBuilderFetch(() => new Response("Not Found", { status: 404 })),
    name: "buildSite returns error when release download fails",
  },
  {
    error: "Create edge script failed",
    input: BUILD_INPUT,
    mocks: () =>
      stubBuildSiteApis({
        createResult: {
          error: "Create edge script failed (500): Server Error",
          ok: false,
        },
      }),
    name: "buildSite returns error when edge script creation fails",
  },
  {
    error: "Update pull zone failed",
    input: BUILD_INPUT,
    mocks: () =>
      stubBuildSiteApis({
        updatePullZoneResult: {
          error: "Update pull zone failed (500): Server Error",
          ok: false,
        },
      }),
    name: "buildSite returns error when pull zone update fails",
  },
  {
    error: "Failed to set secrets",
    input: BUILD_INPUT,
    mocks: () =>
      stubBuildSiteApis({
        secretResult: {
          error: "Set secret DB_URL failed (403): Forbidden",
          ok: false,
        },
      }),
    name: "buildSite returns error when secret setting fails",
  },
  {
    error: "Publish edge script failed",
    input: BUILD_INPUT,
    mocks: () =>
      stubBuildSiteApis({
        publishResult: {
          error: "Publish edge script failed (500): Error",
          ok: false,
        },
      }),
    name: "buildSite returns error when publish fails",
  },
  {
    error: "Create database failed",
    input: { siteName: "Fail Site" },
    mocks: () =>
      stubBuildSiteApis({
        createDbResult: {
          error: "Create database failed (403): Forbidden",
          ok: false,
        },
      }),
    name: "buildSite returns error when auto-create database fails",
  },
];

describeWithEnv(
  "builder",
  {
    db: true,
    env: {
      ADMIN_EMAIL_ADDRESS: "admin@example.com",
      NTFY_URL: "https://ntfy.example.com/test",
      SENTRY_URL: "https://k@bugs.example.com/2",
    },
  },
  () => {
    test("generateEncryptionKey returns 32-byte base64 string", () => {
      const key = builderApi.generateEncryptionKey();
      const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(bytes.length).toBe(32);
    });

    test("testDbConnection succeeds with valid in-memory database", async () => {
      const result = await builderApi.testDbConnection(":memory:", "");
      expect(result.ok).toBe(true);
    });

    test("testDbConnection returns error for invalid URL", async () => {
      const result = await builderApi.testDbConnection(
        "libsql://nonexistent.invalid.host.example",
        "bad-token",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeTruthy();
      }
    });

    for (const { name, mocks, input, error } of ERROR_CASES) {
      test(name, async () => {
        await withMocks(mocks, async () => {
          const result = await builderApi.buildSite(input);
          expectBuildError(result, error);
        });
      });
    }

    test("buildSite copies host secrets when env vars are set", () =>
      withBuildSiteMocks(async ({ secretStub }) => {
        const result = await builderApi.buildSite(BUILD_INPUT);
        expect(result.ok).toBe(true);

        const secretsSet = secretsFrom(secretStub);
        expectSecret(secretsSet, "NTFY_URL", "https://ntfy.example.com/test");
        expectSecret(secretsSet, "SENTRY_URL", "https://k@bugs.example.com/2");
        expectSecret(secretsSet, "ADMIN_EMAIL_ADDRESS", "admin@example.com");
      }));

    test("buildSite succeeds with all steps", () =>
      withBuildSiteMocks(
        async ({ createStub, updatePzStub, publishStub, secretStub }) => {
          const result = await builderApi.buildSite({
            ...BUILD_INPUT,
            siteName: "My Site",
          });

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.hostingId).toBe("42");
            expect(result.defaultHostname).toBe("https://test-42.b-cdn.net");
          }

          expect(createStub.calls[0]!.args[0]).toBe("Tickets - My Site");

          expect(updatePzStub.calls.length).toBe(1);
          expect(updatePzStub.calls[0]!.args[0]).toBe(99);
          expect(updatePzStub.calls[0]!.args[1]).toEqual({
            DisableCookies: false,
          });

          const secretsSet = secretsFrom(secretStub);
          const secretNames = secretsSet.map(([name]) => name);
          expect(secretNames).toContain("DB_URL");
          expect(secretNames).toContain("DB_TOKEN");
          expect(secretNames).toContain("DB_ENCRYPTION_KEY");
          expect(secretNames).toContain("BUNNY_SCRIPT_ID");

          expectSecret(secretsSet, "DB_URL", "libsql://test.turso.io");
          expectSecret(secretsSet, "BUNNY_SCRIPT_ID", "42");

          expect(publishStub.calls.length).toBe(1);
          expect(publishStub.calls[0]!.args[0]).toBe(42);
        },
      ));

    test("buildSite auto-creates database when dbUrl is not provided", () =>
      withBuildSiteMocks(async ({ createDbStub, secretStub }) => {
        const result = await builderApi.buildSite({ siteName: "Auto Site" });

        expect(result.ok).toBe(true);
        expect(createDbStub.calls.length).toBe(1);
        expect(createDbStub.calls[0]!.args[0]).toBe("Auto Site");

        if (result.ok) {
          expect(result.dbUrl).toBe(MOCK_DB_RESULT.dbUrl);
          expect(result.dbToken).toBe(MOCK_DB_RESULT.dbToken);
        }

        const secretsSet = secretsFrom(secretStub);
        expectSecret(secretsSet, "DB_URL", MOCK_DB_RESULT.dbUrl);
        expectSecret(secretsSet, "DB_TOKEN", MOCK_DB_RESULT.dbToken);
      }));

    test("buildSite uses provided dbUrl and dbToken without calling createDatabase", () =>
      withBuildSiteMocks(async ({ createDbStub }) => {
        await builderApi.buildSite({
          dbToken: "provided-token",
          dbUrl: "libsql://provided.io",
          siteName: "Provided",
        });
        expect(createDbStub.calls.length).toBe(0);
      }));

    test("buildSite uses provided code without fetching from GitHub", () =>
      withBuildSiteMocks(async ({ createStub, fetchStub }) => {
        const result = await builderApi.buildSite({
          code: "console.log('local-bundle')",
          siteName: "Local",
        });
        expect(result.ok).toBe(true);

        const fetchedUrls = fetchStub.calls.map((c) => String(c.args[0]));
        expect(fetchedUrls.some((u) => u.includes("github"))).toBe(false);

        const deployedCode = createStub.calls.map((c) => c.args[1]);
        expect(deployedCode).toEqual(["console.log('local-bundle')"]);
      }));

    test("buildSite uses empty string dbToken when dbUrl provided without dbToken", () =>
      withBuildSiteMocks(async ({ createDbStub, secretStub }) => {
        await builderApi.buildSite({
          dbUrl: "libsql://provided.io",
          siteName: "NoToken",
        });
        expect(createDbStub.calls.length).toBe(0);
        expectSecret(secretsFrom(secretStub), "DB_TOKEN", "");
      }));

    test("buildSite succeeds on Deno Deploy hosting", () =>
      withMocks(
        () => stubDenoBuilderApis(),
        async ({ deployStub }) => {
          const result = await builderApi.buildSite({
            dbToken: "tok",
            dbUrl: "libsql://test.turso.io",
            hostingProvider: "deno",
            siteName: "Test",
          });
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.hostingProvider).toBe("deno");
            expect(result.hostingId).toBe("app_abc123");
            expect(result.defaultHostname).toBe(
              "https://tickets-test.deno.dev",
            );
          }
          expect(deployStub.calls).toHaveLength(1);
        },
      ));

    const DENO_ERROR_CASES: {
      name: string;
      mocks: () => Restorable | Record<string, Restorable>;
      error: string;
    }[] = [
      {
        error: "Create app failed",
        mocks: () =>
          stubDenoBuilderApis({
            createAppResult: {
              error: "Create app failed (500): Error",
              ok: false as const,
            },
          }),
        name: "buildSite returns error when Deno app creation fails",
      },
      {
        error: "Failed to set secrets",
        mocks: () =>
          stubDenoBuilderApis({
            setEnvResult: {
              error: "Set env failed (403)",
              ok: false as const,
            },
          }),
        name: "buildSite returns error when Deno setEnvVars fails",
      },
      {
        error: "Deploy failed",
        mocks: () =>
          stubDenoBuilderApis({
            deployResult: {
              error: "Deploy failed (500)",
              ok: false as const,
            },
          }),
        name: "buildSite returns error when Deno deployCode fails",
      },
    ];
    for (const { name, mocks, error } of DENO_ERROR_CASES) {
      test(name, () =>
        withMocks(mocks, async () => {
          const result = await builderApi.buildSite({
            dbToken: "tok",
            dbUrl: "libsql://test.io",
            hostingProvider: "deno",
            siteName: "Fail",
          });
          expectBuildError(result, error);
        }),
      );
    }

    test("createDatabase dispatches to tursoApi when provider is turso", () =>
      withMocks(
        () =>
          stub(tursoApi, "createDatabase", () =>
            Promise.resolve({
              dbId: "turso_db_123",
              dbToken: "turso-token",
              dbUrl: "libsql://turso.io",
              ok: true as const,
            }),
          ),
        async (tursoStub) => {
          const result = await builderApi.createDatabase("My Site", "turso");
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.dbUrl).toContain("turso.io");
          expect(tursoStub.calls).toHaveLength(1);
        },
      ));

    test("createDatabase dispatches to bunnyDbApi when provider is bunny", () =>
      withMocks(
        () =>
          stub(bunnyDbApi, "createDatabase", () =>
            Promise.resolve({
              dbId: "bunny_db_456",
              dbToken: "bunny-token",
              dbUrl: "libsql://bunny.io",
              ok: true as const,
            }),
          ),
        async (bunnyStub) => {
          const result = await builderApi.createDatabase("My Site", "bunny");
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.dbUrl).toContain("bunny.io");
          expect(bunnyStub.calls).toHaveLength(1);
        },
      ));

    test("buildSite auto-creates turso database when dbProvider is turso", () =>
      withMocks(
        () => ({
          ...stubBuildSiteApis(),
          tursoStub: stub(tursoApi, "createDatabase", () =>
            Promise.resolve({
              dbId: "turso_auto",
              dbToken: "turso-tok",
              dbUrl: "libsql://auto.turso.io",
              ok: true as const,
            }),
          ),
        }),
        async ({ tursoStub }) => {
          const result = await builderApi.buildSite({
            dbProvider: "turso",
            siteName: "Turso Auto",
          });
          expect(result.ok).toBe(true);
          expect(tursoStub.calls).toHaveLength(1);
          if (result.ok) {
            expect(result.dbProvider).toBe("turso");
            expect(result.dbUrl).toBe("libsql://auto.turso.io");
          }
        },
      ));

    test("buildSite on Deno does not include Bunny DNS secrets in env vars", () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "host-bunny-key",
        BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
        BUNNY_DNS_ZONE_ID: "zone-123",
      });
      try {
        return withMocks(
          () => stubDenoBuilderApis(),
          async ({ setEnvStub }) => {
            const result = await builderApi.buildSite({
              dbToken: "tok",
              dbUrl: "libsql://test.turso.io",
              hostingProvider: "deno",
              siteName: "Deno Site",
            });
            expect(result.ok).toBe(true);
            const secrets = setEnvStub.calls[0]!.args[1] as [string, string][];
            const names = secrets.map(([name]) => name);
            expect(names).not.toContain("BUNNY_API_KEY");
            expect(names).not.toContain("BUNNY_DNS_ZONE_ID");
            expect(names).not.toContain("BUNNY_DNS_SUBDOMAIN_SUFFIX");
          },
        );
      } finally {
        restore();
      }
    });
  },
);
