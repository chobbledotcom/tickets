import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  assertSettingsReadsDeclared,
  recordSettingRead,
  recordSettingsLoaded,
  runWithSettingsAudit,
  setSettingsAuditEnabled,
} from "#shared/db/settings-audit.ts";

describe("settings-audit", () => {
  afterEach(() => {
    setSettingsAuditEnabled(null);
  });

  describe("when enabled", () => {
    test("passes when every read key was loaded", () => {
      setSettingsAuditEnabled(true);
      runWithSettingsAudit(() => {
        recordSettingsLoaded(["theme", "country"]);
        recordSettingRead("theme");
        // No throw: reads ⊆ loaded.
        assertSettingsReadsDeclared("GET /");
      });
    });

    test("throws naming the route and the undeclared keys", () => {
      setSettingsAuditEnabled(true);
      runWithSettingsAudit(() => {
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
      runWithSettingsAudit(() => {
        recordSettingsLoaded(["country"]);
        recordSettingsLoaded(["business_email"]); // e.g. a write
        recordSettingRead("business_email");
        assertSettingsReadsDeclared("POST /admin/settings");
      });
    });
  });

  describe("when disabled (production)", () => {
    test("runWithSettingsAudit passes the value straight through", () => {
      const result = runWithSettingsAudit(() => 42);
      expect(result).toBe(42);
    });

    test("record/assert helpers are no-ops outside an audit scope", () => {
      // No scope entered: nothing recorded, assert never throws.
      recordSettingRead("stripe_secret_key");
      recordSettingsLoaded(["theme"]);
      assertSettingsReadsDeclared("GET /");
    });
  });
});
