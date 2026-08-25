/** Direct tests for email config resolution: stored, host env, and active.
 * The first suite drives every branch through settings overrides and env
 * scopes; the two `describeWithEnv` suites prove the same reads against a
 * real database write. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  getActiveEmailConfig,
  getEmailConfig,
  getHostEmailConfig,
  resetHostEmailConfig,
} from "#shared/email.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
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

describeWithEnv("getEmailConfig", { db: true }, () => {
  test("returns null when no provider configured", async () => {
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("returns config when all settings present", async () => {
    await configureTestEmail();

    const config = await getEmailConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      fromAddress: "from@test.com",
      provider: "resend",
    });
  });

  test("returns null when API key missing", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.fromAddress("from@test.com");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });

  test("falls back to business email when from address not set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    await updateBusinessEmail("biz@example.com");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      fromAddress: "biz@example.com",
      provider: "resend",
    });
  });

  test("returns null when neither from address nor business email set", async () => {
    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("test-key");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const config = await getEmailConfig();
    expect(config).toBeNull();
  });
});

describeWithEnv(
  "getHostEmailConfig",
  {
    env: {
      HOST_EMAIL_API_KEY: undefined,
      HOST_EMAIL_FROM_ADDRESS: undefined,
      HOST_EMAIL_PROVIDER: undefined,
    },
  },
  () => {
    test("returns null when no env vars set", () => {
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_PROVIDER missing", () => {
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_API_KEY missing", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns null when HOST_EMAIL_FROM_ADDRESS missing", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      expect(getHostEmailConfig()).toBeNull();
    });

    test("returns config with specified provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toEqual({
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
        provider: "resend",
      });
    });

    test("supports mailgun-eu provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-eu");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      expect(getHostEmailConfig()).toEqual({
        apiKey: "key-123",
        fromAddress: "noreply@example.com",
        provider: "mailgun-eu",
      });
    });

    test("returns null and logs error for invalid provider", () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      const errorSpy = spy(console, "error");
      try {
        const config = getHostEmailConfig();
        expect(config).toBeNull();
        const logs = errorSpy.calls.map((c) => c.args[0] as string);
        expect(
          logs.some(
            (l) =>
              l.includes("E_EMAIL_SEND") &&
              l.includes("invalid HOST_EMAIL_PROVIDER"),
          ),
        ).toBe(true);
      } finally {
        errorSpy.restore();
      }
    });
  },
);
