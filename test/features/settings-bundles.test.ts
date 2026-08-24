import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { CONFIG_KEYS } from "#db/settings.ts";
import {
  assertSettingsReadsDeclared,
  recordSettingsLoaded,
  runWithSettingsAudit,
  setSettingsAuditEnabled,
} from "#db/settings-audit.ts";
import { getPrefix, settingsForPath } from "#routes/settings-bundles.ts";
import { paymentProviderUsesSandbox } from "#shared/payment-provider-status.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";

describe("settings bundles", () => {
  test("extracts the first path segment without its leading slash", () => {
    expect(getPrefix("/admin/settings")).toBe("admin");
  });

  test("loads the schema hash for admin routes", () => {
    expect(settingsForPath("/admin")).toContain("db_schema_hash");
  });

  test("keeps the home page bundle narrower than the full settings list", () => {
    expect(settingsForPath("/")).not.toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });

  test("uses the full settings list for inherited object property names", () => {
    expect(settingsForPath("/constructor")).toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });

  test("does not reserve a settings bundle for the early scheduled route", () => {
    expect(settingsForPath("/scheduled")).toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });

  describe("what every response reads", () => {
    afterEach(() => {
      setSettingsAuditEnabled(null);
    });

    // `applySecurityHeaders` rebuilds the policy on every routed response, so
    // whatever it reads must be in the bundle of every route. Asking a
    // provider whether the site points at its test estate must therefore
    // never reach for that provider's stored key: the key is not declared on
    // an ordinary page, and reading it turns the page into a 500.
    for (const provider of PAYMENT_PROVIDER_IDS) {
      test(`asks whether ${provider} is in a sandbox without an undeclared read`, () => {
        setSettingsAuditEnabled(true);
        runWithSettingsAudit(() => {
          recordSettingsLoaded(settingsForPath("/listings"));
          paymentProviderUsesSandbox(provider);
          assertSettingsReadsDeclared("GET /listings");
        });
      });
    }
  });
});
