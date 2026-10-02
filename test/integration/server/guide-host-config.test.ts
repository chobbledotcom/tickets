import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { hostEmail } from "#shared/email.ts";
import { assertAdminHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { guide } from "#test-utils/guide.ts";

describeWithEnv("server (admin guide host config)", { db: true }, () => {
  describe("GET /admin/guide", () => {
    test("shows default email setup instructions when no host email configured", async () => {
      const html = await guide("Choose your email company from the dropdown");
      expect(html).not.toContain(
        "already set up by the company that runs your site",
      );
    });

    test("shows host email config and setup instructions when configured", async () => {
      hostEmail.setOverride({
        apiKey: "re_test_key",
        fromAddress: validEmail("tickets@example.com"),
        provider: "resend",
      });
      try {
        await assertAdminHtml(
          "/admin/guide",
          "already set up by the company that runs your site",
          "Resend",
          "tickets@example.com",
          "Choose your email company from the dropdown",
        );
      } finally {
        hostEmail.resetOverride();
      }
    });

    test("shows default Google Wallet setup when no host config", async () => {
      const html = await guide("You need three values from");
      expect(html).not.toContain(
        "already set up by the company that runs your site",
      );
    });

    test("shows host Google Wallet config when env vars set", async () => {
      settings.googleWallet.setHostConfigForTest({
        issuerId: "3388000000012345678",
        serviceAccountEmail: "wallet@project.iam.gserviceaccount.com",
        serviceAccountKey: "pem-key-data",
      });
      try {
        await assertAdminHtml(
          "/admin/guide",
          "already set up by the company that runs your site, using",
          "3388000000012345678",
          "You need three values from",
        );
      } finally {
        settings.googleWallet.resetHostConfig();
      }
    });

    test("shows default wallet setup instructions when no host wallet configured", async () => {
      const html = await guide("You need five values from");
      expect(html).not.toContain(
        "already set up by the company that runs your site",
      );
    });

    test("shows host wallet config and setup instructions when configured", async () => {
      settings.appleWallet.setHostConfigForTest({
        passTypeId: "pass.com.host.tickets",
        signingCert: "cert-data",
        signingKey: "key-data",
        teamId: "HOSTTEAM01",
        wwdrCert: "wwdr-data",
      });
      try {
        await assertAdminHtml(
          "/admin/guide",
          "already set up by the company that runs your site, using",
          "pass.com.host.tickets",
          "You need five values from",
        );
      } finally {
        settings.appleWallet.resetHostConfig();
      }
    });

    test("hides built sites section when builder is disabled", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const html = await assertAdminHtml("/admin/guide");
      expect(html).not.toContain('id="built-sites"');
    });

    test("cached guide is pinned to builder-off even under ambient CAN_BUILD_SITES=true", async () => {
      using _ambient = withEnv({ CAN_BUILD_SITES: "true" });
      const live = await assertAdminHtml("/admin/guide", 'id="built-sites"');
      expect(live).toContain('id="built-sites"');
      const cached = await guide();
      expect(cached).not.toContain('id="built-sites"');
    });

    test("shows built sites section when builder is enabled", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      await assertAdminHtml(
        "/admin/guide",
        'id="built-sites"',
        "Add Built Site",
      );
    });
  });
});
