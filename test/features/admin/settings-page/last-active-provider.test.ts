import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
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
      assertStringIncludes(
        html,
        "Changing your domain changes your payment webhook",
      );
      assertStringIncludes(html, 'href="/admin/settings#settings-stripe"');
      const settingsHtml = await (await adminGet("/admin/settings")).text();
      assertStringIncludes(settingsHtml, 'id="settings-stripe"');
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
      );
      expect(form).not.toBeNull();
      if (form === null) return;
      assertStringIncludes(form[0], 'id="settings-payment-provider-recovery"');
      for (const provider of ["stripe", "square"]) {
        const input = inputTagWithValue(
          form[0],
          provider,
          "existing_payment_provider",
        );
        assertStringIncludes(input, "required");
      }
      expect(hasCheckedInput(html, "payment_provider", "none")).toBe(true);
    });
  },
);
