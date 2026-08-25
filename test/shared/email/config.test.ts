/** Direct tests for email config resolution: stored, host env, and active. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import {
  getActiveEmailConfig,
  getEmailConfig,
  getHostEmailConfig,
  resetHostEmailConfig,
} from "#shared/email.ts";
import { withEnv } from "#test-utils/env.ts";

type SettingsOverrides = Parameters<typeof settings.setForTest>[0];

/** Override every key getEmailConfig reads, so no test touches a database. */
const overrideSiteEmail = (overrides: SettingsOverrides = {}): void =>
  settings.setForTest({
    business_email: "",
    email_api_key: "site-key",
    email_from_address: "site@example.com",
    email_provider: "resend",
    ...overrides,
  });

const hostEnv = {
  HOST_EMAIL_API_KEY: "host-key",
  HOST_EMAIL_FROM_ADDRESS: "host@example.com",
  HOST_EMAIL_PROVIDER: "postmark",
};

const hostConfig = {
  apiKey: "host-key",
  fromAddress: "host@example.com",
  provider: "postmark",
};

describe("email config resolution", () => {
  beforeEach(() => {
    settings.clearTestOverrides();
    resetHostEmailConfig();
  });

  afterEach(() => {
    settings.clearTestOverrides();
    resetHostEmailConfig();
  });

  describe("getEmailConfig", () => {
    test("prefers the stored from address over the business email", () => {
      overrideSiteEmail({ business_email: "owner@example.com" });
      expect(getEmailConfig()).toEqual({
        apiKey: "site-key",
        fromAddress: "site@example.com",
        provider: "resend",
      });
    });

    test("falls back to the business email when no from address is stored", () => {
      overrideSiteEmail({
        business_email: "owner@example.com",
        email_from_address: "",
      });
      expect(getEmailConfig()?.fromAddress).toBe("owner@example.com");
    });

    test("is null while no provider is stored", () => {
      overrideSiteEmail({ email_provider: "" });
      expect(getEmailConfig()).toBeNull();
    });

    test("is null while the api key is missing", () => {
      overrideSiteEmail({ email_api_key: "" });
      expect(getEmailConfig()).toBeNull();
    });

    test("is null while no address is available", () => {
      overrideSiteEmail({ email_from_address: "" });
      expect(getEmailConfig()).toBeNull();
    });

    test("throws on an unknown stored provider", () => {
      overrideSiteEmail({ email_provider: "imap" });
      expect(() => getEmailConfig()).toThrow(
        "Unknown stored email provider: imap",
      );
    });
  });

  describe("getHostEmailConfig", () => {
    test("reads the HOST_EMAIL_* environment", () => {
      using _env = withEnv(hostEnv);
      expect(getHostEmailConfig()).toEqual(hostConfig);
    });

    test("is null while any host variable is missing", () => {
      using _env = withEnv({ ...hostEnv, HOST_EMAIL_API_KEY: undefined });
      expect(getHostEmailConfig()).toBeNull();
    });

    test("logs and refuses an unknown host provider", () => {
      using _env = withEnv({ ...hostEnv, HOST_EMAIL_PROVIDER: "imap" });
      using errors = stub(console, "error");
      expect(getHostEmailConfig()).toBeNull();
      const logged = errors.calls
        .map((call) => String(call.args[0]))
        .join("\n");
      expect(logged).toContain('invalid HOST_EMAIL_PROVIDER: "imap"');
    });
  });

  describe("getActiveEmailConfig", () => {
    test("prefers the site config over the host config", () => {
      using _env = withEnv(hostEnv);
      overrideSiteEmail();
      expect(getActiveEmailConfig()).toEqual({
        apiKey: "site-key",
        fromAddress: "site@example.com",
        provider: "resend",
      });
    });

    test("falls back to the host config when the site has none", () => {
      using _env = withEnv(hostEnv);
      overrideSiteEmail({ email_provider: "" });
      expect(getActiveEmailConfig()).toEqual(hostConfig);
    });
  });
});
