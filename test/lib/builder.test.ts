import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#lib/builder.ts";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { describeWithEnv, withMocks } from "#test-utils";

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
                  tag_name: "v2026-01-01-000000",
                  name: "Test",
                  published_at: "2026-01-01T00:00:00Z",
                  assets: [],
                }),
                { status: 200 },
              ),
            ),
          ),
        async () => {
          const result = await builderApi.buildSite({
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
                    tag_name: "v2026-01-01-000000",
                    name: "Test",
                    published_at: "2026-01-01T00:00:00Z",
                    assets: [
                      {
                        name: "bunny-script.ts",
                        browser_download_url: "https://example.com/script.ts",
                      },
                    ],
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
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      tag_name: "v2026-01-01-000000",
                      name: "Test Release",
                      published_at: "2026-01-01T00:00:00Z",
                      assets: [
                        {
                          name: "bunny-script.ts",
                          browser_download_url: "https://example.com/script.ts",
                        },
                      ],
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
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              ok: true as const,
              scriptId: 42,
              defaultHostname: "test-42.b-cdn.net",
            }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      tag_name: "v2026-01-01-000000",
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      assets: [
                        {
                          name: "bunny-script.ts",
                          browser_download_url: "https://example.com/script.ts",
                        },
                      ],
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
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              ok: false as const,
              error: "Create edge script failed (500): Server Error",
            }),
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      tag_name: "v2026-01-01-000000",
                      name: "Test Release",
                      published_at: "2026-01-01T00:00:00Z",
                      assets: [
                        {
                          name: "bunny-script.ts",
                          browser_download_url: "https://example.com/script.ts",
                        },
                      ],
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
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              ok: true as const,
              scriptId: 42,
              defaultHostname: "test-42.b-cdn.net",
            }),
          ),
          secretStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              secretsSet.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
        }),
        async ({ createStub, publishStub }) => {
          const result = await builderApi.buildSite({
            siteName: "My Site",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
          });

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.scriptId).toBe(42);
            expect(result.defaultHostname).toBe("test-42.b-cdn.net");
          }

          // Verify script was created with correct name
          expect(createStub.calls[0]!.args[0]).toBe("Tickets - My Site");

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

    test("buildSite returns error when secret setting fails", async () => {
      await withMocks(
        () => ({
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      tag_name: "v2026-01-01-000000",
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      assets: [
                        {
                          name: "bunny-script.ts",
                          browser_download_url: "https://example.com/script.ts",
                        },
                      ],
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
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              ok: true as const,
              scriptId: 42,
              defaultHostname: "test.b-cdn.net",
            }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({
              ok: false as const,
              error: "Set secret DB_URL failed (403): Forbidden",
            }),
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({ ok: true as const }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
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
          fetchStub: stub(
            globalThis,
            "fetch",
            (input: string | URL | Request) => {
              const url = String(input);
              if (url.includes("releases/latest")) {
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      tag_name: "v2026-01-01-000000",
                      name: "Test",
                      published_at: "2026-01-01T00:00:00Z",
                      assets: [
                        {
                          name: "bunny-script.ts",
                          browser_download_url: "https://example.com/script.ts",
                        },
                      ],
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
          createStub: stub(bunnyCdnApi, "createEdgeScript", () =>
            Promise.resolve({
              ok: true as const,
              scriptId: 42,
              defaultHostname: "test.b-cdn.net",
            }),
          ),
          secretStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({ ok: true as const }),
          ),
          publishStub: stub(bunnyCdnApi, "publishEdgeScript", () =>
            Promise.resolve({
              ok: false as const,
              error: "Publish edge script failed (500): Error",
            }),
          ),
          encKeyStub: stub(
            builderApi,
            "generateEncryptionKey",
            () => "dGVzdGtleQ==",
          ),
        }),
        async () => {
          const result = await builderApi.buildSite({
            siteName: "Test",
            dbUrl: "libsql://test.turso.io",
            dbToken: "token123",
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Publish edge script failed");
          }
        },
      );
    });
  },
);
