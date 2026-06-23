import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectRedirectWithFlash,
  followRedirectWithFlash,
  getAllActivityLog,
  mockFormRequest,
  mockRequestWithHost,
  testCookie,
  testCsrfToken,
  withMockBunnyCdnApi,
} from "#test-utils";

describeWithEnv("server (admin settings: domains)", { db: true }, () => {
  describeWithEnv(
    "custom domain",
    { env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined } },
    () => {
      let restoreCdnHostname: (() => void) | null = null;
      afterEach(() => {
        if (restoreCdnHostname) {
          restoreCdnHostname();
          restoreCdnHostname = null;
        }
      });

      const setBunnyEnv = () => {
        Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
        Deno.env.set("BUNNY_SCRIPT_ID", "99");
        const original = bunnyCdnApi.getCdnHostname;
        bunnyCdnApi.getCdnHostname = () =>
          Promise.resolve({
            hostname: "mysite.b-cdn.net",
            ok: true as const,
          });
        restoreCdnHostname = () => {
          bunnyCdnApi.getCdnHostname = original;
        };
      };

      test("does not show custom domain form when Bunny CDN is not configured", async () => {
        Deno.env.delete("BUNNY_API_KEY");
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain('id="settings-custom-domain"');
      });

      test("shows custom domain form when Bunny CDN is configured", async () => {
        setBunnyEnv();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain('id="settings-custom-domain"');
        expect(html).toContain("Custom Domain");
      });

      test("does not show validate form when no custom domain is saved", async () => {
        setBunnyEnv();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain('id="settings-custom-domain-validate"');
      });

      test("shows validate form and CNAME instructions when custom domain is saved", async () => {
        setBunnyEnv();
        await settings.update.customDomain("tickets.example.com");
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain('id="settings-custom-domain-validate"');
        expect(html).toContain("CNAME");
        expect(html).toContain("tickets.example.com");
        // CDN hostname is fetched from the edge script API
        expect(html).toContain("mysite.b-cdn.net");
      });

      test("shows warning when custom domain is not validated", async () => {
        setBunnyEnv();
        await settings.update.customDomain("tickets.example.com");
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("not yet validated");
        expect(html).toContain("will not work until validation is complete");
      });

      test("does not show warning when custom domain is validated", async () => {
        setBunnyEnv();
        await settings.update.customDomain("tickets.example.com");
        await settings.update.customDomainLastValidated();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain("not yet validated");
      });

      test("shows last validated timestamp when domain has been validated", async () => {
        setBunnyEnv();
        // Get session token before setting the validated custom domain,
        // then re-format the cookie for the secure domain cookie name.
        const cookie = await testCookie();
        const token = cookie.split("=").slice(1).join("=");
        await settings.update.customDomain("tickets.example.com");
        await settings.update.customDomainLastValidated();
        const response = await handleRequest(
          mockRequestWithHost(
            "/admin/settings-advanced",
            "tickets.example.com",
            {
              headers: { cookie: `__Host-session=${token}` },
            },
          ),
        );
        const html = await response.text();
        expect(html).toContain("Last validated:");
      });

      describe("POST /admin/settings/custom-domain", () => {
        test("rejects when Bunny CDN is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "tickets.example.com" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Bunny CDN is not configured"),
            false,
          );
        });

        test("saves and validates domain when validation succeeds", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Custom domain saved and validated"),
            );
            expect(settings.customDomain).toBe("tickets.example.com");
            expect(settings.customDomainLastValidated).not.toBeNull();
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("saves domain with error message when validation fails", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              error: "DNS not configured",
              ok: false as const,
            });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("validation failed"),
              false,
            );
            expectFlash(
              response,
              expect.stringContaining("DNS not configured"),
              false,
            );
            expect(settings.customDomain).toBe("tickets.example.com");
            expect(settings.customDomainLastValidated).toBe("");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("normalizes domain to lowercase", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "Tickets.Example.COM",
            });
            expect(settings.customDomain).toBe("tickets.example.com");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears custom domain when empty", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Custom domain cleared"),
          );
          expect(settings.customDomain).toBe("");
        });

        test("clears domain when field is missing from form", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Custom domain cleared"),
          );
          expect(settings.customDomain).toBe("");
        });

        test("rejects invalid domain format", async () => {
          setBunnyEnv();
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain",
            { custom_domain: "not a domain!" },
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Invalid domain format"),
            false,
          );
        });

        test("logs activity when domain is set", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            const log = await getAllActivityLog();
            expect(
              log.some((e) =>
                e.message.includes("Custom domain set to tickets.example.com"),
              ),
            ).toBe(true);
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("logs validation activity when save triggers successful validation", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            const log = await getAllActivityLog();
            expect(
              log.some((e) => e.message.includes("Custom domain validated")),
            ).toBe(true);
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });
      });

      describe("POST /admin/settings/custom-domain/validate", () => {
        test("rejects when Bunny CDN is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain/validate",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Bunny CDN is not configured"),
            false,
          );
        });

        test("rejects when no custom domain is saved", async () => {
          setBunnyEnv();
          const { response } = await adminFormPost(
            "/admin/settings/custom-domain/validate",
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("No custom domain"),
            false,
          );
        });

        test("calls Bunny API and saves timestamp on success", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Custom domain validated successfully"),
            );
            const lastValidated = settings.customDomainLastValidated;
            expect(lastValidated).not.toBeNull();
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("returns error when Bunny API fails", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              error: "Add hostname failed (400): Hostname already exists",
              ok: false as const,
            });
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("Add hostname failed"),
              false,
            );
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("logs activity on successful validation", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain/validate");
            const log = await getAllActivityLog();
            expect(
              log.some((e) => e.message.includes("Custom domain validated")),
            ).toBe(true);
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });
      });

      describe("current_task guard", () => {
        test("rejects custom-domain save when a task is already in progress", async () => {
          setBunnyEnv();
          await settings.update.currentTask("some-other-task");
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain",
              { custom_domain: "tickets.example.com" },
            );
            await expectFlashRedirect(
              "/admin/settings-advanced?form=settings-custom-domain#settings-custom-domain",
              expect.stringContaining("Another task is already in progress"),
              false,
            )(response);
          } finally {
            await settings.update.currentTask("");
          }
        });

        test("rejects custom-domain validate when a task is already in progress", async () => {
          setBunnyEnv();
          await settings.update.customDomain("tickets.example.com");
          await settings.update.currentTask("some-other-task");
          try {
            const { response } = await adminFormPost(
              "/admin/settings/custom-domain/validate",
            );
            await expectFlashRedirect(
              "/admin/settings-advanced?form=settings-custom-domain-validate#settings-custom-domain-validate",
              expect.stringContaining("Another task is already in progress"),
              false,
            )(response);
          } finally {
            await settings.update.currentTask("");
          }
        });

        test("clears current_task after successful custom-domain save", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({ ok: true as const });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            expect(settings.currentTask).toBe("");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears current_task after failed custom-domain validation", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () =>
            Promise.resolve({
              error: "DNS not configured",
              ok: false as const,
            });
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
            expect(settings.currentTask).toBe("");
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
        });

        test("clears current_task even when the task throws", async () => {
          setBunnyEnv();
          const original = bunnyCdnApi.validateCustomDomain;
          bunnyCdnApi.validateCustomDomain = () => {
            throw new Error("network failure");
          };
          try {
            await adminFormPost("/admin/settings/custom-domain", {
              custom_domain: "tickets.example.com",
            });
          } catch {
            // The stubbed error may be rethrown by handleRequest's
            // test guard — that's fine, we only care that current_task
            // was cleared by the finally block in withCurrentTask.
          } finally {
            bunnyCdnApi.validateCustomDomain = original;
          }
          expect(settings.currentTask).toBe("");
        });
      });
    },
  );

  describeWithEnv(
    "host subdomain",
    {
      env: {
        BUNNY_API_KEY: undefined,
        BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
        BUNNY_DNS_ZONE_ID: undefined,
        BUNNY_SCRIPT_ID: undefined,
      },
    },
    () => {
      let restoreCdnHostname: (() => void) | null = null;

      const setBunnyDnsEnv = () => {
        Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
        Deno.env.set("BUNNY_SCRIPT_ID", "test-script-id");
        Deno.env.set("BUNNY_DNS_ZONE_ID", "42");
        Deno.env.set("BUNNY_DNS_SUBDOMAIN_SUFFIX", ".tickets");
        const original = bunnyCdnApi.getCdnHostname;
        bunnyCdnApi.getCdnHostname = () =>
          Promise.resolve({ hostname: "test.b-cdn.net", ok: true as const });
        restoreCdnHostname = () => {
          bunnyCdnApi.getCdnHostname = original;
        };
      };

      afterEach(() => {
        if (restoreCdnHostname) {
          restoreCdnHostname();
          restoreCdnHostname = null;
        }
      });

      test("does not show host subdomain section when DNS not configured", async () => {
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain('id="settings-host-subdomain"');
      });

      test("shows host subdomain section when DNS is configured", async () => {
        setBunnyDnsEnv();
        const response = await awaitTestRequest("/admin/settings-advanced", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain('id="settings-host-subdomain"');
        expect(html).toContain("Host Subdomain");
        expect(html).toContain(
          "Check Availability &amp; Preview Complete Domain",
        );
      });

      test("shows registered subdomain and custom domain text", async () => {
        setBunnyDnsEnv();
        const cookie = await testCookie();
        const token = cookie.split("=").slice(1).join("=").split(";")[0];
        await settings.update.bunnySubdomain("mylisting.tickets.example.com");
        const response = await handleRequest(
          mockRequestWithHost(
            "/admin/settings-advanced",
            "mylisting.tickets.example.com",
            {
              headers: {
                cookie: `__Host-session=${token}`,
              },
            },
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("mylisting.tickets.example.com");
        expect(html).toContain("permanent and cannot be changed");
        expect(html).toContain("can be active at the same time");
      });

      describe("POST /admin/settings/host-subdomain", () => {
        test("rejects when DNS is not configured", async () => {
          Deno.env.delete("BUNNY_API_KEY");
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/host-subdomain",
              {
                csrf_token: await testCsrfToken(),
                subdomain: "mylisting",
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Not configured"),
            false,
          );
        });

        test("rejects when subdomain already set", async () => {
          setBunnyDnsEnv();
          const csrfToken = await testCsrfToken();
          const cookie = await testCookie();
          const token = cookie.split("=").slice(1).join("=");
          await settings.update.bunnySubdomain("existing.tickets.example.com");
          const response = await handleRequest(
            mockRequestWithHost(
              "/admin/settings/host-subdomain",
              "existing.tickets.example.com",
              {
                body: `subdomain=mylisting&csrf_token=${encodeURIComponent(
                  csrfToken,
                )}`,
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  cookie: `__Host-session=${token}`,
                },
                method: "POST",
              },
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("already"), false);
        });

        test("rejects invalid subdomain format", async () => {
          setBunnyDnsEnv();
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/host-subdomain",
              {
                csrf_token: await testCsrfToken(),
                subdomain: "-invalid",
              },
              await testCookie(),
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Invalid subdomain"),
            false,
          );
        });

        test("previews subdomain availability without save", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  available: true,
                  fullDomain: "mylisting.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "mylisting",
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              const location = response.headers.get("location")!;
              expect(location).toContain("form=settings-host-subdomain");
              expectFlash(response, expect.stringContaining("is available"));
            },
          );
        });

        test("renders subdomain preview on page after availability check", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  available: true,
                  fullDomain: "mylisting.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const cookie = await testCookie();
              const postResponse = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "mylisting",
                  },
                  cookie,
                ),
              );
              const page = await followRedirectWithFlash(
                postResponse,
                handleRequest,
                cookie,
              );
              const html = await page.text();
              expect(html).toContain("mylisting.tickets.example.com");
              expect(html).toContain("is available");
            },
          );
        });

        test("preview returns error when availability check fails", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  error: "DNS zone error",
                  ok: false as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "mylisting",
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("DNS zone error"),
                false,
              );
            },
          );
        });

        test("preview returns error when subdomain is taken", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              checkSubdomainAvailable: () =>
                Promise.resolve({
                  available: false,
                  fullDomain: "mylisting.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    subdomain: "mylisting",
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("already taken"),
                false,
              );
            },
          );
        });

        test("registers subdomain with save flag, saves to DB, and logs activity", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              registerBunnySubdomain: () =>
                Promise.resolve({
                  fullDomain: "mylisting.tickets.example.com",
                  ok: true as const,
                }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    save: "1",
                    subdomain: "mylisting",
                  },
                  await testCookie(),
                ),
              );
              // Cookie-only: following re-renders settings-advanced, which
              // re-issues the Bunny CDN calls only mocked for this POST.
              expectRedirectWithFlash(
                "/admin/settings-advanced?form=settings-host-subdomain#settings-host-subdomain",
                "Subdomain registered: mylisting.tickets.example.com",
              )(response);
              expect(settings.bunnySubdomain).toBe(
                "mylisting.tickets.example.com",
              );
              const log = await getAllActivityLog();
              expect(
                log.some((e) =>
                  e.message.includes(
                    "Host subdomain set to mylisting.tickets.example.com",
                  ),
                ),
              ).toBe(true);
            },
          );
        });

        test("returns error when registration fails", async () => {
          setBunnyDnsEnv();
          await withMockBunnyCdnApi(
            {
              registerBunnySubdomain: () =>
                Promise.resolve({ error: "DNS error", ok: false as const }),
            },
            async () => {
              const response = await handleRequest(
                mockFormRequest(
                  "/admin/settings/host-subdomain",
                  {
                    csrf_token: await testCsrfToken(),
                    save: "1",
                    subdomain: "mylisting",
                  },
                  await testCookie(),
                ),
              );
              expect(response.status).toBe(302);
              expectFlash(
                response,
                expect.stringContaining("DNS error"),
                false,
              );
            },
          );
        });

        test("rejects registration when a task is already in progress", async () => {
          setBunnyDnsEnv();
          await settings.update.currentTask("some-other-task");
          try {
            const response = await handleRequest(
              mockFormRequest(
                "/admin/settings/host-subdomain",
                {
                  csrf_token: await testCsrfToken(),
                  save: "1",
                  subdomain: "mylisting",
                },
                await testCookie(),
              ),
            );
            await expectFlashRedirect(
              "/admin/settings-advanced?form=settings-host-subdomain#settings-host-subdomain",
              expect.stringContaining("Another task is already in progress"),
              false,
            )(response);
          } finally {
            await settings.update.currentTask("");
          }
        });
      });
    },
  );
});
