import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv, withMocks } from "#test-utils";

const MOCK_DB_RESULT = {
  dbId: "db_auto123",
  dbToken: "auto-token",
  dbUrl: "libsql://auto.lite.bunnydb.net",
  ok: true as const,
};

describeWithEnv(
  "builder",
  { db: true, env: { NTFY_URL: "https://ntfy.example.com/test" } },
  () => {
    test("generateEncryptionKey returns 32-byte base64 string", () => {
      const key = builderApi.generateEncryptionKey();
      const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(bytes.length).toBe(32);
    });

    test("generateEncryptionKey produces unique keys", () => {
      const key1 = builderApi.generateEncryptionKey();
      const key2 = builderApi.generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });

    test("buildSite returns error when release has no asset", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  assets: [],
                  name: "Test",
                  published_at: "2026-01-01T00:00:00Z",
                  tag_name: "v2026-01-01-000000",
                }),
                { status: 200 },
              ),
            ),
          ),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("No release asset");
          }
        },
      );
    });

    test("buildSite returns error when GitHub API fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Not Found", { status: 404 })),
          ),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Failed to fetch release");
          }
        },
      );
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

    test("buildSite returns error when release download fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("releases/latest")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    assets: [
                      {
                        browser_download_url: "https://example.com/script.ts",
                        name: "bunny-script.ts",
                      },
                    ],
                    name: "Test",
                    published_at: "2026-01-01T00:00:00Z",
                    tag_name: "v2026-01-01-000000",
                  }),
                  { status: 200 },
                ),
              );
            }
            // Asset download fails
            return Promise.resolve(new Response("Not Found", { status: 404 }));
          }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Failed to download release");
          }
        },
      );
    });

    test("buildSite copies host secrets when env vars are set", async () => {
      const secretsSet: [string, string][] = [];

      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test-42.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test Release",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              if (url.includes("example.com/script.ts")) {
                return Promise.resolve(
                  new Response("console.log('code')", { status: 200 }),
                );
              }
              return Promise.resolve(new Response("error", { status: 500 }));
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });

          expect(result.ok).toBe(true);

          // NTFY_URL should have been copied from env
          const ntfySecret = secretsSet.find(([n]) => n === "NTFY_URL");
          expect(ntfySecret).toBeDefined();
          expect(ntfySecret![1]).toBe("https://ntfy.example.com/test");
        },
      );
    });

    test("buildSite returns error when edge script creation fails", async () => {
      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              error: "Create edge script failed (500): Server Error",
              ok: false as const,
            }),
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              if (url.includes("example.com/script.ts")) {
                return Promise.resolve(
                  new Response("console.log('code')", { status: 200 }),
                );
              }
              return Promise.resolve(new Response("error", { status: 500 }));
            },
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Create edge script failed");
          }
        },
      );
    });

    test("buildSite succeeds with all steps", async () => {
      const secretsSet: [string, string][] = [];

      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test-42.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test Release",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              if (url.includes("example.com/script.ts")) {
                return Promise.resolve(
                  new Response("console.log('code')", { status: 200 }),
                );
              }
              return Promise.resolve(new Response("error", { status: 500 }));
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async ({ createStub, updatePzStub, publishStub }) => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "My Site",
          });

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.scriptId).toBe(42);
            expect(result.defaultHostname).toBe("https://test-42.b-cdn.net");
          }

          // Verify script was created with correct name
          expect(createStub.calls[0]!.args[0]).toBe("Tickets - My Site");

          // Verify pull zone was updated with DisableCookies: false
          expect(updatePzStub.calls.length).toBe(1);
          expect(updatePzStub.calls[0]!.args[0]).toBe(99);
          expect(updatePzStub.calls[0]!.args[1]).toEqual({
            DisableCookies: false,
          });

          // Verify required secrets were set
          const secretNames = secretsSet.map(([name]) => name);
          expect(secretNames).toContain("DB_URL");
          expect(secretNames).toContain("DB_TOKEN");
          expect(secretNames).toContain("DB_ENCRYPTION_KEY");
          expect(secretNames).toContain("BUNNY_SCRIPT_ID");

          // Verify secret values
          const dbUrlSecret = secretsSet.find(([n]) => n === "DB_URL");
          expect(dbUrlSecret![1]).toBe("libsql://test.turso.io");
          const scriptIdSecret = secretsSet.find(
            ([n]) => n === "BUNNY_SCRIPT_ID",
          );
          expect(scriptIdSecret![1]).toBe("42");

          // Verify publish was called
          expect(publishStub.calls.length).toBe(1);
          expect(publishStub.calls[0]!.args[0]).toBe(42);
        },
      );
    });

    test("buildSite returns error when pull zone update fails", async () => {
      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              return Promise.resolve(
                new Response("console.log('code')", { status: 200 }),
              );
            },
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({
              error: "Update pull zone failed (500): Server Error",
              ok: false as const,
            }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Update pull zone failed");
          }
        },
      );
    });

    test("buildSite returns error when secret setting fails", async () => {
      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              return Promise.resolve(
                new Response("console.log('code')", { status: 200 }),
              );
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({
              error: "Set secret DB_URL failed (403): Forbidden",
              ok: false as const,
            }),
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Failed to set secrets");
          }
        },
      );
    });

    test("buildSite returns error when publish fails", async () => {
      await withMocks(
        () => ({
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      assets: [
                        {
                          browser_download_url: "https://example.com/script.ts",
                          name: "bunny-script.ts",
                        },
                      ],
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      tag_name: "v2026-01-01-000000",
                    }),
                    { status: 200 },
                  ),
                );
              }
              return Promise.resolve(
                new Response("console.log('code')", { status: 200 }),
              );
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({
              error: "Publish edge script failed (500): Error",
              ok: false as const,
            }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({ ok: true as const }),
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            dbToken: "token123",
            dbUrl: "libsql://test.turso.io",
            siteName: "Test",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Publish edge script failed");
          }
        },
      );
    });

    test("buildSite auto-creates database when dbUrl is not provided", async () => {
      const secretsSet: [string, string][] = [];

      await withMocks(
        () => ({
          createDbStub: stub(
            builderApi,
            "createDatabase",
            () => Promise.resolve(MOCK_DB_RESULT),
          ),
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://auto-42.b-cdn.net",
              ok: true as const,
              pullZoneId: 99,
              scriptId: 42,
            }),
          ),
          encKeyStub: stub(builderApi, "generateEncryptionKey", () => "dGVzdGtleQ=="),
          fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("releases/latest")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    assets: [
                      {
                        browser_download_url: "https://example.com/script.ts",
                        name: "bunny-script.ts",
                      },
                    ],
                    name: "Test Release",
                    published_at: "2026-01-01T00:00:00Z",
                    tag_name: "v2026-01-01-000000",
                  }),
                  { status: 200 },
                ),
              );
            }
            if (url.includes("example.com/script.ts")) {
              return Promise.resolve(new Response("console.log('code')", { status: 200 }));
            }
            return Promise.resolve(new Response("error", { status: 500 }));
          }),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async ({ createDbStub }) => {
          const result = await builderApi.buildSite({ siteName: "Auto Site" });

          expect(result.ok).toBe(true);
          expect(createDbStub.calls.length).toBe(1);
          expect(createDbStub.calls[0]!.args[0]).toBe("Auto Site");

          if (result.ok) {
            expect(result.dbUrl).toBe(MOCK_DB_RESULT.dbUrl);
            expect(result.dbToken).toBe(MOCK_DB_RESULT.dbToken);
          }

          const dbUrlSecret = secretsSet.find(([n]) => n === "DB_URL");
          expect(dbUrlSecret![1]).toBe(MOCK_DB_RESULT.dbUrl);
          const dbTokenSecret = secretsSet.find(([n]) => n === "DB_TOKEN");
          expect(dbTokenSecret![1]).toBe(MOCK_DB_RESULT.dbToken);
        },
      );
    });

    test("buildSite returns error when auto-create database fails", async () => {
      await withMocks(
        () => ({
          createDbStub: stub(builderApi, "createDatabase", () =>
            Promise.resolve({ error: "Create database failed (403): Forbidden", ok: false as const }),
          ),
          fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("releases/latest")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    assets: [
                      {
                        browser_download_url: "https://example.com/script.ts",
                        name: "bunny-script.ts",
                      },
                    ],
                    name: "Test",
                    published_at: "2026-01-01T00:00:00Z",
                    tag_name: "v2026-01-01-000000",
                  }),
                  { status: 200 },
                ),
              );
            }
            return Promise.resolve(new Response("code", { status: 200 }));
          }),
        }),
        async () => {
          const result = await builderApi.buildSite({ siteName: "Fail Site" });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Create database failed");
          }
        },
      );
    });

    test("buildSite uses provided dbUrl and dbToken without calling createDatabase", async () => {
      await withMocks(
        () => ({
          createDbStub: stub(builderApi, "createDatabase", () =>
            Promise.resolve(MOCK_DB_RESULT),
          ),
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              pullZoneId: 1,
              scriptId: 1,
            }),
          ),
          encKeyStub: stub(builderApi, "generateEncryptionKey", () => "key=="),
          fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("releases/latest")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    assets: [
                      {
                        browser_download_url: "https://example.com/s.ts",
                        name: "bunny-script.ts",
                      },
                    ],
                    name: "T",
                    published_at: "2026-01-01T00:00:00Z",
                    tag_name: "v2026-01-01-000000",
                  }),
                  { status: 200 },
                ),
              );
            }
            return Promise.resolve(new Response("code", { status: 200 }));
          }),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({ ok: true as const }),
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async ({ createDbStub }) => {
          await builderApi.buildSite({
            dbToken: "provided-token",
            dbUrl: "libsql://provided.io",
            siteName: "Provided",
          });
          expect(createDbStub.calls.length).toBe(0);
        },
      );
    });

    test("buildSite uses provided code without fetching from GitHub", async () => {
      const fetchedUrls: string[] = [];
      const deployedCode: string[] = [];

      await withMocks(
        () => ({
          createDbStub: stub(builderApi, "createDatabase", () =>
            Promise.resolve(MOCK_DB_RESULT),
          ),
          createStub: stub(
            bunnyCdnApi,
            "createEdgeScript",
            (_name: string, code: string) => {
              deployedCode.push(code);
              return Promise.resolve({
                defaultHostname: "https://test.b-cdn.net",
                ok: true as const,
                pullZoneId: 1,
                scriptId: 1,
              });
            },
          ),
          encKeyStub: stub(builderApi, "generateEncryptionKey", () => "key=="),
          fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
            fetchedUrls.push(String(input));
            return Promise.resolve(new Response("should-not-be-called", { status: 500 }));
          }),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({ ok: true as const }),
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            code: "console.log('local-bundle')",
            siteName: "Local",
          });
          expect(result.ok).toBe(true);
          expect(fetchedUrls.some((u) => u.includes("github"))).toBe(false);
          expect(deployedCode).toEqual(["console.log('local-bundle')"]);
        },
      );
    });

    test("buildSite uses empty string dbToken when dbUrl provided without dbToken", async () => {
      const secretsSet: [string, string][] = [];

      await withMocks(
        () => ({
          createDbStub: stub(builderApi, "createDatabase", () =>
            Promise.resolve(MOCK_DB_RESULT),
          ),
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              defaultHostname: "https://test.b-cdn.net",
              ok: true as const,
              pullZoneId: 1,
              scriptId: 1,
            }),
          ),
          encKeyStub: stub(builderApi, "generateEncryptionKey", () => "key=="),
          fetchStub: stub(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("releases/latest")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    assets: [
                      {
                        browser_download_url: "https://example.com/s.ts",
                        name: "bunny-script.ts",
                      },
                    ],
                    name: "T",
                    published_at: "2026-01-01T00:00:00Z",
                    tag_name: "v2026-01-01-000000",
                  }),
                  { status: 200 },
                ),
              );
            }
            return Promise.resolve(new Response("code", { status: 200 }));
          }),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          updatePzStub: stub(bunnyCdnApi, "updatePullZone", () =>
            Promise.resolve({ ok: true as const }),
          ),
        }),
        async ({ createDbStub }) => {
          await builderApi.buildSite({ dbUrl: "libsql://provided.io", siteName: "NoToken" });
          expect(createDbStub.calls.length).toBe(0);
          const dbTokenSecret = secretsSet.find(([n]) => n === "DB_TOKEN");
          expect(dbTokenSecret![1]).toBe("");
        },
      );
    });
  },
);
