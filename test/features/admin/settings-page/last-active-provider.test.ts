import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminGet } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv(
  "settings-advanced state carries lastActivePaymentProvider",
  { db: true },
  () => {
    test("renders the domain-change warning via the last-active provider when sales are off", async () => {
      await setupStripe();
      await settings.update.setPaymentProviderNone();
      using _env = withEnv({
        BUNNY_API_KEY: "bunny-key",
        BUNNY_DNS_ZONE_ID: "zone-id",
        BUNNY_SCRIPT_ID: undefined,
      });
      const html = await (await adminGet("/admin/settings-advanced")).text();
      expect(html).toContain(
        "Changing your domain changes your payment webhook",
      );
      expect(html).toContain('href="/admin/settings#settings-stripe"');
      const settingsHtml = await (await adminGet("/admin/settings")).text();
      expect(settingsHtml).toContain('id="settings-stripe"');
    });

    test("requires a provider choice when stored credentials are ambiguous", async () => {
      await setupStripe();
      await settings.update.square.accessToken("square-recovery-token");
      await settings.update.setPaymentProviderNone();
      await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const html = await (await adminGet("/admin/settings")).text();
      const form = html.match(
        /<form[^>]*action="\/admin\/settings\/payment-provider-recovery"[^>]*>[\s\S]*?<\/form>/,
      )?.[0];
      expect(form).toContain('id="settings-payment-provider-recovery"');
      expect(form).toMatch(
        /<input[^>]*name="existing_payment_provider"[^>]*required[^>]*value="stripe"/,
      );
      expect(form).toMatch(
        /<input[^>]*name="existing_payment_provider"[^>]*required[^>]*value="square"/,
      );
      expect(html).toMatch(/<input[^>]*checked[^>]*value="none"/);
    });
  },
);
