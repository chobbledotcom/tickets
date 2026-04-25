import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { settings } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectRedirectWithFlash,
  mockRequestWithHost,
  testCookie,
} from "#test-utils";

describeWithEnv(
  "server (admin settings-advanced: custom domain)",
  { db: true },
  () => {
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
                  e.message.includes(
                    "Custom domain set to tickets.example.com",
                  ),
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
              expectRedirectWithFlash(
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
              expectRedirectWithFlash(
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

    describe("POST /admin/settings/event-column-order", () => {
      const formUrl =
        "/admin/settings-advanced?form=settings-event-column-order#settings-event-column-order";

      test("saves valid event column order", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/event-column-order",
          { column_order: "{{name}}, {{status}}" },
        );
        expectRedirectWithFlash(
          formUrl,
          "Event column order updated",
        )(response);
        expect(settings.eventColumnOrder).toBe("{{name}}, {{status}}");
      });

      test("rejects invalid column name", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/event-column-order",
          { column_order: "{{invalid}}" },
        );
        expectRedirectWithFlash(formUrl, undefined, false)(response);
        const msg = decodeURIComponent(
          response.headers.get("set-cookie") ?? "",
        );
        expect(msg).toContain("invalid");
        expect(msg).toContain("Available columns");
      });

      test("clears to default when empty", async () => {
        await settings.update.eventColumnOrder("{{name}}");
        const { response } = await adminFormPost(
          "/admin/settings/event-column-order",
          { column_order: "" },
        );
        expectRedirectWithFlash(
          formUrl,
          "Event column order updated",
        )(response);
        expect(settings.eventColumnOrder).toBe("");
      });
    });

    describe("POST /admin/settings/attendee-column-order", () => {
      const formUrl =
        "/admin/settings-advanced?form=settings-attendee-column-order#settings-attendee-column-order";

      test("saves valid attendee column order", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/attendee-column-order",
          { column_order: "{{name}}, {{qty}}, {{ticket}}" },
        );
        expectRedirectWithFlash(
          formUrl,
          "Attendee column order updated",
        )(response);
        expect(settings.attendeeColumnOrder).toBe(
          "{{name}}, {{qty}}, {{ticket}}",
        );
      });

      test("rejects invalid column name", async () => {
        const { response } = await adminFormPost(
          "/admin/settings/attendee-column-order",
          { column_order: "{{bogus}}" },
        );
        expectRedirectWithFlash(formUrl, undefined, false)(response);
        const msg = decodeURIComponent(
          response.headers.get("set-cookie") ?? "",
        );
        expect(msg).toContain("bogus");
        expect(msg).toContain("Available columns");
      });

      test("clears to default when empty", async () => {
        await settings.update.attendeeColumnOrder("{{name}}");
        const { response } = await adminFormPost(
          "/admin/settings/attendee-column-order",
          { column_order: "" },
        );
        expectRedirectWithFlash(
          formUrl,
          "Attendee column order updated",
        )(response);
        expect(settings.attendeeColumnOrder).toBe("");
      });
    });
  },
);
