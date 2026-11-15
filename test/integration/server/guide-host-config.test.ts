import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { hostEmail } from "#shared/email.ts";
import { assertAdminHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { expectGuidePage } from "#test-utils/guide.ts";

describeWithEnv("server (admin guide host config)", { db: true }, () => {
  describe("GET /admin/guide", () => {
    /** The guide's host-config marker, shown only when the site supplies it. */
    const HOST_CONFIGURED = "already set up by the company that runs your site";

    /** Assert the guide falls back to `heading` and names no host config. */
    const expectDefaultGuide = async (heading: string) => {
      const html = await expectGuidePage(heading);
      assert(!html.includes(HOST_CONFIGURED));
    };

    /** Assert the guide names `expected` once `configure` supplies the host
     *  config, then drop the override. */
    const expectHostConfiguredGuide = async (
      configure: () => void,
      reset: () => void,
      ...expected: string[]
    ) => {
      configure();
      try {
        await assertAdminHtml("/admin/guide", ...expected);
      } finally {
        reset();
      }
    };

    test("shows default email setup instructions when no host email configured", async () => {
      await expectDefaultGuide("Choose your email company from the dropdown");
    });

    test("shows host email config and setup instructions when configured", async () => {
      await expectHostConfiguredGuide(
        () =>
          hostEmail.setOverride({
            apiKey: "re_test_key",
            fromAddress: validEmail("tickets@example.com"),
            provider: "resend",
          }),
        () => hostEmail.resetOverride(),
        HOST_CONFIGURED,
        "Resend",
        "tickets@example.com",
        "Choose your email company from the dropdown",
      );
    });

    /** Each wallet brand's guide fallback heading. */
    const walletDefaults = [
      {
        heading: "You need three values from",
        name: "shows default Google Wallet setup when no host config",
      },
      {
        heading: "You need five values from",
        name: "shows default wallet setup instructions when no host wallet configured",
      },
    ];

    for (const { heading, name } of walletDefaults) {
      test(name, async () => {
        await expectDefaultGuide(heading);
      });
    }

    /** Each wallet brand whose host config the guide can show. */
    const walletHosts = [
      {
        apply: () =>
          settings.googleWallet.setHostConfigForTest({
            issuerId: "3388000000012345678",
            serviceAccountEmail: "wallet@project.iam.gserviceaccount.com",
            serviceAccountKey: "pem-key-data",
          }),
        name: "shows host Google Wallet config when env vars set",
        named: ["3388000000012345678", "You need three values from"],
        reset: () => settings.googleWallet.resetHostConfig(),
      },
      {
        apply: () =>
          settings.appleWallet.setHostConfigForTest({
            passTypeId: "pass.com.host.tickets",
            signingCert: "cert-data",
            signingKey: "key-data",
            teamId: "HOSTTEAM01",
            wwdrCert: "wwdr-data",
          }),
        name: "shows host wallet config and setup instructions when configured",
        named: ["pass.com.host.tickets", "You need five values from"],
        reset: () => settings.appleWallet.resetHostConfig(),
      },
    ];

    for (const wallet of walletHosts) {
      test(wallet.name, async () => {
        await expectHostConfiguredGuide(
          wallet.apply,
          wallet.reset,
          `${HOST_CONFIGURED}, using`,
          ...wallet.named,
        );
      });
    }

    test("hides built sites section when builder is disabled", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const html = await assertAdminHtml("/admin/guide");
      assert(!html.includes('id="built-sites"'));
    });

    test("cached guide is pinned to builder-off even under ambient CAN_BUILD_SITES=true", async () => {
      using _ambient = withEnv({ CAN_BUILD_SITES: "true" });
      const live = await assertAdminHtml("/admin/guide", 'id="built-sites"');
      assertStringIncludes(live, 'id="built-sites"');
      const cached = await expectGuidePage();
      assert(!cached.includes('id="built-sites"'));
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
