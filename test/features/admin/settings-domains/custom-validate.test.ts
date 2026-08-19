import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  describeCustomDomain,
  expectActivityLogged,
  withValidatedDomain,
} from "#test/features/admin/settings-domains/support.ts";
import {
  expectFlashRedirect,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { withMockBunnyCdnApi } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";

const PATH = "/admin/settings/custom-domain/validate";
const REDIRECT =
  "/admin/settings-advanced?form=settings-custom-domain-validate#settings-custom-domain-validate";

describeCustomDomain("custom domain validation", (enable) => {
  describe("POST /admin/settings/custom-domain/validate", () => {
    test("rejects when Bunny CDN is not configured", async () => {
      const { response } = await adminFormPost(PATH);
      expectRedirectWithFlash(
        REDIRECT,
        "Bunny CDN is not configured",
        false,
      )(response);
    });

    test("rejects when no custom domain is saved", async () => {
      enable();
      const { response } = await adminFormPost(PATH);
      expectRedirectWithFlash(
        REDIRECT,
        "No custom domain is configured",
        false,
      )(response);
    });

    test("saves the validation time and logs success", async () => {
      enable();
      await settings.update.customDomain("tickets.example.com");
      await withValidatedDomain(async () => {
        const { response } = await adminFormPost(PATH);
        expectRedirectWithFlash(
          REDIRECT,
          "Custom domain validated successfully",
        )(response);
        expect(settings.customDomainLastValidated).not.toBe("");
        await expectActivityLogged("Custom domain validated");
      });
    });

    test("reports a Bunny validation failure", async () => {
      enable();
      await settings.update.customDomain("tickets.example.com");
      await withMockBunnyCdnApi(
        {
          validateCustomDomain: () =>
            Promise.resolve({
              error: "Add hostname failed (400): Hostname already exists",
              ok: false as const,
            }),
        },
        async () => {
          const { response } = await adminFormPost(PATH);
          expectRedirectWithFlash(
            REDIRECT,
            expect.stringContaining("Add hostname failed"),
            false,
          )(response);
        },
      );
    });

    test("holds the validation task lock during the Bunny call", async () => {
      enable();
      await settings.update.customDomain("tickets.example.com");
      await withMockBunnyCdnApi(
        {
          validateCustomDomain: () => {
            expect(settings.currentTask).toBe("custom-domain-validate");
            return Promise.resolve({ ok: true as const });
          },
        },
        async () => {
          await adminFormPost(PATH);
        },
      );
    });
  });

  describe("current task guard", () => {
    const whileTaskRuns = async (body: () => Promise<void>): Promise<void> => {
      await settings.update.currentTask("some-other-task");
      try {
        await body();
      } finally {
        await settings.update.currentTask("");
      }
    };

    test("rejects a save when another task is running", async () => {
      enable();
      await whileTaskRuns(async () => {
        const { response } = await adminFormPost(
          "/admin/settings/custom-domain",
          { custom_domain: "tickets.example.com" },
        );
        await expectFlashRedirect(
          "/admin/settings-advanced?form=settings-custom-domain#settings-custom-domain",
          expect.stringContaining("Another task is already in progress"),
          false,
        )(response);
      });
    });

    test("rejects validation when another task is running", async () => {
      enable();
      await settings.update.customDomain("tickets.example.com");
      await whileTaskRuns(async () => {
        const { response } = await adminFormPost(PATH);
        await expectFlashRedirect(
          REDIRECT,
          expect.stringContaining("Another task is already in progress"),
          false,
        )(response);
      });
    });

    test("clears the task after successful and failed validation", async () => {
      enable();
      await withValidatedDomain(async () => {
        await adminFormPost("/admin/settings/custom-domain", {
          custom_domain: "tickets.example.com",
        });
        expect(settings.currentTask).toBe("");
      });
      await withMockBunnyCdnApi(
        {
          validateCustomDomain: () =>
            Promise.resolve({
              error: "DNS not configured",
              ok: false as const,
            }),
        },
        async () => {
          await adminFormPost("/admin/settings/custom-domain", {
            custom_domain: "tickets.example.com",
          });
          expect(settings.currentTask).toBe("");
        },
      );
    });

    test("clears the task when validation throws", async () => {
      enable();
      const original = bunnyCdnApi.validateCustomDomain;
      bunnyCdnApi.validateCustomDomain = () => {
        throw new Error("network failure");
      };
      try {
        await adminFormPost("/admin/settings/custom-domain", {
          custom_domain: "tickets.example.com",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("network failure");
      } finally {
        bunnyCdnApi.validateCustomDomain = original;
      }
      expect(settings.currentTask).toBe("");
    });
  });
});
