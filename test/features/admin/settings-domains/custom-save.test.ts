import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  describeCustomDomain,
  expectActivityLogged,
  requirePaymentProviderRecovery,
  withValidatedDomain,
} from "#test/features/admin/settings-domains/support.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { withMockBunnyCdnApi } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";

const REDIRECT =
  "/admin/settings-advanced?form=settings-custom-domain#settings-custom-domain";

describeCustomDomain("POST /admin/settings/custom-domain", (enable) => {
  const post = (customDomain?: string) =>
    adminFormPost(
      "/admin/settings/custom-domain",
      customDomain === undefined ? undefined : { custom_domain: customDomain },
    );

  test("rejects when Bunny CDN is not configured", async () => {
    const { response } = await post("tickets.example.com");
    expectRedirectWithFlash(
      REDIRECT,
      "Bunny CDN is not configured",
      false,
    )(response);
  });

  test("blocks changes until payment provider recovery is complete", async () => {
    enable();
    await requirePaymentProviderRecovery();
    const { response } = await post("tickets.example.com");
    expectRedirectWithFlash(
      REDIRECT,
      "Choose the provider for existing payments before changing your domain.",
      false,
    )(response);
    expect(settings.customDomain).toBe("");
  });

  test("saves and validates a normalized domain", async () => {
    enable();
    await withValidatedDomain(async () => {
      const { response } = await post("Tickets.Example.COM");
      expectRedirectWithFlash(
        REDIRECT,
        "Custom domain saved and validated",
      )(response);
      expect(settings.customDomain).toBe("tickets.example.com");
      expect(settings.customDomainLastValidated).not.toBe("");
      await expectActivityLogged("Custom domain set to tickets.example.com");
      await expectActivityLogged("Custom domain validated");
    });
  });

  test("saves the domain and reports a validation failure", async () => {
    enable();
    await withMockBunnyCdnApi(
      {
        validateCustomDomain: () =>
          Promise.resolve({
            error: "DNS not configured",
            ok: false as const,
          }),
      },
      async () => {
        const { response } = await post("tickets.example.com");
        expectRedirectWithFlash(
          REDIRECT,
          expect.stringContaining("validation failed"),
          false,
        )(response);
        expectFlash(
          response,
          expect.stringContaining("DNS not configured"),
          false,
        );
        expect(settings.customDomain).toBe("tickets.example.com");
        expect(settings.customDomainLastValidated).toBe("");
      },
    );
  });

  for (const field of ["empty", "missing"] as const) {
    test(`clears the domain when the field is ${field}`, async () => {
      enable();
      await settings.update.customDomain("tickets.example.com");
      const { response } = await post(field === "empty" ? "" : undefined);
      expectRedirectWithFlash(REDIRECT, "Custom domain cleared")(response);
      expect(settings.customDomain).toBe("");
      await expectActivityLogged("Custom domain cleared");
    });
  }

  test("does not clear the domain while another settings task runs", async () => {
    enable();
    await settings.update.customDomain("tickets.example.com");
    await settings.update.currentTask("payment-provider-stripe");
    try {
      const { response } = await post("");
      expectRedirectWithFlash(
        REDIRECT,
        "Another task is already in progress",
        false,
      )(response);
      expect(settings.customDomain).toBe("tickets.example.com");
    } finally {
      await settings.update.currentTask("");
    }
  });

  test("rejects an invalid domain", async () => {
    enable();
    const { response } = await post("not a domain!");
    expectRedirectWithFlash(REDIRECT, "Invalid domain format", false)(response);
  });

  test("holds the custom-domain task lock while validating", async () => {
    enable();
    await withMockBunnyCdnApi(
      {
        validateCustomDomain: () => {
          expect(settings.currentTask).toBe("custom-domain");
          return Promise.resolve({ ok: true as const });
        },
      },
      async () => {
        await post("tickets.example.com");
      },
    );
  });
});
