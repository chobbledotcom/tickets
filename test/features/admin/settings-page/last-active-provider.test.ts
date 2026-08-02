import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
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
    });
  },
);
