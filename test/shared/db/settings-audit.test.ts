import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  assertSettingsReadsDeclared,
  recordSettingRead,
  recordSettingsLoaded,
  setSettingsAuditEnabled,
} from "#db/settings-audit.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("settings-audit", () => {
  afterEach(() => {
    setSettingsAuditEnabled(null);
  });

  describe("when enabled", () => {
    test("passes when every read key was loaded", () => {
      setSettingsAuditEnabled(true);
      withRequestContext(() => {
        recordSettingsLoaded(["theme", "country"]);
        recordSettingRead("theme");
        // No throw: reads ⊆ loaded.
        assertSettingsReadsDeclared("GET /");
      });
    });

    test("throws naming the route and the undeclared keys", () => {
      setSettingsAuditEnabled(true);
      withRequestContext(() => {
        recordSettingsLoaded(["theme"]);
        recordSettingRead("theme");
        recordSettingRead("stripe_secret_key");
        expect(() => assertSettingsReadsDeclared("GET /listings")).toThrow(
          /GET \/listings.*stripe_secret_key/,
        );
      });
    });

    test("treats a key written this request as available to read", () => {
      setSettingsAuditEnabled(true);
      withRequestContext(() => {
        recordSettingsLoaded(["country"]);
        recordSettingsLoaded(["business_email"]); // e.g. a write
        recordSettingRead("business_email");
        assertSettingsReadsDeclared("POST /admin/settings");
      });
    });
  });

  describe("when disabled (production)", () => {
    test("record/assert helpers are no-ops outside an audit", () => {
      // No state, nothing recorded, assert never throws.
      recordSettingRead("stripe_secret_key");
      recordSettingsLoaded(["theme"]);
      assertSettingsReadsDeclared("GET /");
    });
  });
});
