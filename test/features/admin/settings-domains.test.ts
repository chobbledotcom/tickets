import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  handleCustomDomainPost,
  handleHostSubdomainPost,
} from "#routes/admin/settings-domains.ts";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { expectErrorFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const setAmbiguousPaymentProvider = async (): Promise<void> => {
  await settings.update.stripe.secretKey("sk_test_domain_recovery");
  await settings.update.square.accessToken("square-domain-recovery");
  await settings.update.setPaymentProviderNone();
  await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

describeWithEnv(
  "domain settings payment provider recovery",
  {
    db: true,
    env: {
      BUNNY_API_KEY: "test-bunny-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "42",
      BUNNY_SCRIPT_ID: "test-script-id",
    },
  },
  () => {
    const post = async (
      handler: (request: Request) => Promise<Response>,
      path: string,
      fields: Record<string, string>,
    ): Promise<Response> =>
      handler(
        mockFormRequest(
          path,
          { csrf_token: await testCsrfToken(), ...fields },
          await testCookie(),
        ),
      );

    test("blocks a custom domain change while provider recovery is required", async () => {
      await setAmbiguousPaymentProvider();
      const response = await post(
        handleCustomDomainPost,
        "/admin/settings/custom-domain",
        { custom_domain: "tickets.example.com" },
      );

      expectErrorFlash(
        response,
        "Choose the provider for existing payments before changing your domain.",
      );
      expect(settings.customDomain).toBe("");
    });

    test("blocks subdomain registration while provider recovery is required", async () => {
      await setAmbiguousPaymentProvider();
      const response = await post(
        handleHostSubdomainPost,
        "/admin/settings/host-subdomain",
        { save: "1", subdomain: "mylisting" },
      );

      expectErrorFlash(
        response,
        "Choose the provider for existing payments before changing your domain.",
      );
      expect(settings.bunnySubdomain).toBe("");
    });
  },
);
